/**
 * 真实学术文献检索：四个免费来源 + 失败降级链。
 *
 * 来源（均无需 API key）：
 * 1. Semantic Scholar Graph API  https://api.semanticscholar.org/graph/v1/paper/search
 * 2. DBLP                         https://dblp.org/search/publ/api
 * 3. arXiv                        https://export.arxiv.org/api/query（Atom XML）
 * 4. Crossref                     https://api.crossref.org/works
 *
 * 红线（DESIGN 最高标准之一）：论文引用只能来自这里的真实检索结果。
 * 本模块不产出任何"凭记忆生成"的文献记录。
 */

import { createHash } from 'node:crypto'
import { isAbortError } from '../../shared/fs-errors.ts'

export type LitType = 'article' | 'inproceedings' | 'misc' | 'book' | 'phdthesis'

export interface LitRecord {
  /** 缓存 ID：sha1(doi ?? url ?? title)，save/note 用它引用（防止 AI 转述元数据出错）。 */
  readonly id: string
  readonly title: string
  readonly authors: readonly string[]
  readonly year: number | null
  readonly venue: string
  readonly type: LitType
  readonly doi?: string
  readonly url?: string
  readonly abstract?: string
  readonly citationCount?: number
  readonly source: string
}

export type LitSource = 'auto' | 'semantic-scholar' | 'dblp' | 'arxiv' | 'crossref'

export interface LitSearchOptions {
  readonly query: string
  readonly yearFrom?: number
  readonly limit?: number
  readonly source?: LitSource
  readonly signal?: AbortSignal
}

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>

const DEFAULT_FETCH: FetchLike = (url, init) => fetch(url, init)

const MAX_RESULTS = 20
const REQUEST_TIMEOUT_MS = 15000

function timedFetch(fetchImpl: FetchLike, url: string, outerSignal?: AbortSignal): Promise<Response> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const signal = outerSignal === undefined ? timeout : AbortSignal.any([outerSignal, timeout])
  return fetchImpl(url, { signal })
}

async function json(fetchImpl: FetchLike, url: string, outerSignal?: AbortSignal): Promise<unknown> {
  const res = await timedFetch(fetchImpl, url, outerSignal)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.json()
}

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

function decodeEntities(text: string): string {
  return text
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&apos;', "'")
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => String.fromCodePoint(Number.parseInt(h, 16)))
}

function stripTags(text: string): string {
  // 先解码实体（&lt;em&gt; → <em>），再剥标签，最后再解码一次（处理剥标签后残留的实体）。
  const decoded = decodeEntities(text)
  return decodeEntities(decoded.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
}

function classifyVenue(venue: string, hasArxivId: boolean): LitType {
  const v = venue.toLowerCase()
  if (/journal|transactions|review|letters|magazine|quarterly|acta|annals/.test(v)) return 'article'
  if (/conference|symposium|workshop|proceedings|meeting|congress/.test(v)) return 'inproceedings'
  if (hasArxivId) return 'misc'
  return 'article'
}

function cleanAbstract(raw: string | undefined, max = 600): string | undefined {
  if (raw === undefined) return undefined
  const text = stripTags(raw).trim()
  if (text === '') return undefined
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function normalizeTitle(raw: string | undefined): string {
  return stripTags(raw ?? '').replace(/\s+/g, ' ').trim()
}

// ---------------------------------------------------------------------------
// 1. Semantic Scholar
// ---------------------------------------------------------------------------

interface SsItem {
  readonly paperId: string
  readonly title?: string
  readonly authors?: Array<{ readonly name: string }>
  readonly year?: number | null
  readonly venue?: string
  readonly abstract?: string | null
  readonly url?: string
  readonly citationCount?: number
  readonly externalIds?: { readonly DOI?: string; readonly ArXiv?: string }
}

async function searchSemanticScholar(fetchImpl: FetchLike, opts: LitSearchOptions): Promise<LitRecord[]> {
  const limit = Math.min(opts.limit ?? 10, MAX_RESULTS)
  const params = new URLSearchParams({ query: opts.query, limit: String(limit), fields: 'title,authors,year,venue,abstract,url,citationCount,externalIds' })
  if (opts.yearFrom !== undefined) params.set('year', `${opts.yearFrom}-`)
  const body = await json(fetchImpl, `https://api.semanticscholar.org/graph/v1/paper/search?${params}`, opts.signal) as { data?: SsItem[] }
  return (body.data ?? []).flatMap(item => {
    const hasArxiv = item.externalIds?.ArXiv !== undefined
    const title = normalizeTitle(item.title)
    if (title === '') return []
    const abstract = cleanAbstract(item.abstract ?? undefined)
    return [{
      id: makeId(item.externalIds?.DOI, item.url ?? (hasArxiv ? `https://arxiv.org/abs/${item.externalIds!.ArXiv}` : undefined), title),
      title,
      authors: (item.authors ?? []).map(a => a.name).filter((n): n is string => n !== undefined && n !== ''),
      year: item.year ?? null,
      venue: item.venue ?? '',
      type: classifyVenue(item.venue ?? '', hasArxiv),
      ...(item.externalIds?.DOI !== undefined ? { doi: item.externalIds.DOI } : {}),
      ...(item.url !== undefined ? { url: item.url } : {}),
      ...(abstract !== undefined ? { abstract } : {}),
      ...(item.citationCount !== undefined ? { citationCount: item.citationCount } : {}),
      source: 'semantic-scholar',
    }]
  })
}

// ---------------------------------------------------------------------------
// 2. DBLP
// ---------------------------------------------------------------------------

interface DblpHit {
  readonly info?: {
    readonly title?: string
    readonly authors?: { readonly author?: unknown }
    readonly year?: string | number
    readonly venue?: string
    readonly type?: string
    readonly doi?: string
    readonly url?: string
    readonly ee?: string
  }
}

function dblpAuthors(raw: unknown): string[] {
  if (raw === undefined) return []
  const list = Array.isArray(raw) ? raw : [raw]
  return list.map(a => {
    if (typeof a === 'string') return a
    if (a !== null && typeof a === 'object' && 'text' in a && typeof (a as { text: unknown }).text === 'string') {
      return (a as { text: string }).text
    }
    return ''
  }).filter(n => n !== '' && !/^\d{4}(-\d{4}){0,3}$/.test(n.trim()))
}

async function searchDblp(fetchImpl: FetchLike, opts: LitSearchOptions): Promise<LitRecord[]> {
  const limit = Math.min(opts.limit ?? 10, MAX_RESULTS)
  const params = new URLSearchParams({ q: opts.query, format: 'json', h: String(limit) })
  const body = await json(fetchImpl, `https://dblp.org/search/publ/api?${params}`, opts.signal) as { result?: { hits?: { hit?: DblpHit[] | DblpHit } } }
  const hits = body.result?.hits?.hit
  const list: DblpHit[] = hits === undefined ? [] : Array.isArray(hits) ? hits : [hits]
  return list.map(hit => {
    const info = hit.info ?? {}
    const title = normalizeTitle(info.title)
    const year = typeof info.year === 'number' ? info.year : (info.year !== undefined ? Number.parseInt(String(info.year), 10) : Number.NaN)
    const venue = info.venue ?? ''
    // CoRR / arXiv 是预印本，即使 DBLP 按期刊条目收录也标为 misc。
    const isPreprint = /coRR|arxiv/i.test(venue)
    const typeMap: Record<string, LitType> = {
      'Conference and Workshop Papers': 'inproceedings',
      'Journal Articles': 'article',
      'Books and Theses': 'book',
    }
    const type: LitType = isPreprint ? 'misc' : (typeMap[info.type ?? ''] ?? (info.doi !== undefined ? 'article' : 'inproceedings'))
    const url = info.ee ?? info.url
    return {
      id: makeId(info.doi, url, title),
      title,
      authors: dblpAuthors(info.authors?.author),
      year: Number.isNaN(year) ? null : year,
      venue,
      type,
      ...(info.doi !== undefined ? { doi: info.doi } : {}),
      ...(url !== undefined ? { url } : {}),
      source: 'dblp',
    }
  }).filter(r => r.title !== '')
}

// ---------------------------------------------------------------------------
// 3. arXiv（Atom XML，最小解析器 + fixtures 测试）
// ---------------------------------------------------------------------------

function parseArxivAtom(xml: string): Array<{ title: string; summary: string; authors: string[]; arxivId: string; doi?: string; published: string }> {
  const entries: Array<{ title: string; summary: string; authors: string[]; arxivId: string; doi?: string; published: string }> = []
  const entryBlocks = xml.split('<entry').slice(1)
  for (const block of entryBlocks) {
    const grab = (tag: string): string | undefined => {
      const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(block)
      return m?.[1] === undefined ? undefined : decodeEntities(stripTags(m[1]))
    }
    const title = grab('title')
    if (title === undefined || title === '') continue
    const idText = grab('id')
    const arxivId = idText?.split('/abs/').pop()?.replace(/v\d+$/, '') ?? ''
    const doiText = grab('doi')
    const published = grab('published') ?? ''
    const names = [...block.matchAll(/<name>([\s\S]*?)<\/name>/g)].map(m => decodeEntities(m[1]?.trim() ?? ''))
      .filter(n => n !== '')
    entries.push({
      title,
      summary: grab('summary') ?? '',
      authors: names,
      arxivId,
      ...(doiText !== undefined && doiText !== '' ? { doi: doiText } : {}),
      published,
    })
  }
  return entries
}

async function searchArxiv(fetchImpl: FetchLike, opts: LitSearchOptions): Promise<LitRecord[]> {
  const limit = Math.min(opts.limit ?? 10, MAX_RESULTS)
  const query = `all:${encodeURIComponent(opts.query)}`
  const url = `https://export.arxiv.org/api/query?search_query=${query}&start=0&max_results=${limit}`
  const res = await timedFetch(fetchImpl, url, opts.signal)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const xml = await res.text()
  return parseArxivAtom(xml).flatMap(entry => {
    const yearRaw = Number.parseInt(entry.published.slice(0, 4), 10)
    const year = Number.isNaN(yearRaw) ? null : yearRaw
    if (opts.yearFrom !== undefined && year !== null && year < opts.yearFrom) return []
    const absUrl = `https://arxiv.org/abs/${entry.arxivId}`
    const abstract = cleanAbstract(entry.summary)
    return [{
      id: makeId(entry.doi, absUrl, entry.title),
      title: entry.title,
      authors: entry.authors,
      year,
      venue: 'arXiv preprint',
      type: 'misc' as const,
      ...(entry.doi !== undefined ? { doi: entry.doi } : {}),
      url: absUrl,
      ...(abstract !== undefined ? { abstract } : {}),
      source: 'arxiv',
    }]
  })
}

// ---------------------------------------------------------------------------
// 4. Crossref
// ---------------------------------------------------------------------------

interface CrossrefItem {
  readonly DOI?: string
  readonly title?: string[]
  readonly author?: Array<{ readonly given?: string; readonly family?: string; readonly name?: string }>
  readonly issued?: { readonly 'date-parts'?: number[][] }
  readonly 'container-title'?: string[]
  readonly type?: string
  readonly abstract?: string
  readonly URL?: string
}

async function searchCrossref(fetchImpl: FetchLike, opts: LitSearchOptions): Promise<LitRecord[]> {
  const limit = Math.min(opts.limit ?? 10, MAX_RESULTS)
  const params = new URLSearchParams({ query: opts.query, rows: String(limit), select: 'DOI,title,author,issued,container-title,type,abstract,URL' })
  const body = await json(fetchImpl, `https://api.crossref.org/works?${params}`, opts.signal) as { message?: { items?: CrossrefItem[] } }
  const items = body.message?.items ?? []
  const typeMap: Record<string, LitType> = {
    'journal-article': 'article',
    'proceedings-article': 'inproceedings',
    book: 'book',
    monograph: 'book',
    dissertation: 'phdthesis',
    'posted-content': 'misc',
  }
  return items.flatMap(item => {
    const doi = item.DOI
    if (doi === undefined) return []
    const title = normalizeTitle(item.title?.[0])
    const year = item.issued?.['date-parts']?.[0]?.[0] ?? null
    if (opts.yearFrom !== undefined && year !== null && year < opts.yearFrom) return []
    return [{
      id: makeId(doi, item.URL, title),
      title,
      authors: (item.author ?? []).map(a => a.name ?? [a.given, a.family].filter(Boolean).join(' ').trim()).filter(n => n !== ''),
      year,
      venue: item['container-title']?.[0] ?? '',
      type: typeMap[item.type ?? ''] ?? 'article',
      doi,
      ...(item.URL !== undefined ? { url: item.URL } : {}),
      ...cleanAbstract(item.abstract) !== undefined ? { abstract: cleanAbstract(item.abstract)! } : {},
      source: 'crossref',
    }]
  })
}

// ---------------------------------------------------------------------------
// 组合检索（降级链）
// ---------------------------------------------------------------------------

export function makeId(doi: string | undefined, url: string | undefined, title: string): string {
  const basis = (doi ?? url ?? title).trim().toLowerCase()
  return createHash('sha1').update(basis).digest('hex').slice(0, 16)
}

const SOURCE_ORDER: readonly Exclude<LitSource, 'auto'>[] = ['semantic-scholar', 'dblp', 'arxiv', 'crossref']

const SEARCHERS: Readonly<Record<Exclude<LitSource, 'auto'>, (fetchImpl: FetchLike, opts: LitSearchOptions) => Promise<LitRecord[]>>> = {
  'semantic-scholar': searchSemanticScholar,
  dblp: searchDblp,
  arxiv: searchArxiv,
  crossref: searchCrossref,
}

export const LIT_SOURCES: readonly string[] = ['semantic-scholar', 'dblp', 'arxiv', 'crossref']

/**
 * 检索文献。source=auto 时按 Semantic Scholar → DBLP → arXiv → Crossref 顺序
 * 降级：某源失败（网络/限流/超时）则尝试下一源；首个返回 ≥1 条结果的源胜出。
 * 返回按年被引/年份排序后的去重列表（重复判定：id 相同）。
 *
 * **取消不是失败**：调用方取消时立刻把 `AbortError` 抛出去，不去试下一个源——
 * 否则用户按了停止，工具会继续打四个学术 API（最多 60 秒），最后报一句
 * 「所有检索源均未返回结果」，把取消误导成网络问题。
 */
export async function searchLiterature(fetchImpl: FetchLike, opts: LitSearchOptions): Promise<LitRecord[]> {
  const forced = opts.source !== undefined && opts.source !== 'auto' ? opts.source : undefined
  if (forced !== undefined && SEARCHERS[forced] === undefined) {
    throw new Error(`未知的检索来源「${forced}」。可用：${LIT_SOURCES.join(' | ')}，或省略 source 走降级链（auto）。`)
  }
  const order: readonly Exclude<LitSource, 'auto'>[] = forced !== undefined ? [forced] : SOURCE_ORDER
  const errors: string[] = []
  for (const source of order) {
    try {
      const results = await SEARCHERS[source](fetchImpl, opts)
      if (results.length > 0) {
        return dedupe(results)
          .sort((a, b) => (b.citationCount ?? b.year ?? 0) - (a.citationCount ?? a.year ?? 0))
      }
      errors.push(`${source}: 无结果`)
    } catch (error) {
      if (isAbortError(error)) throw error
      errors.push(`${source}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`所有检索源均未返回结果。${errors.join('；')}`)
}

function dedupe(records: LitRecord[]): LitRecord[] {
  const seen = new Set<string>()
  const out: LitRecord[] = []
  for (const record of records) {
    if (seen.has(record.id)) continue
    seen.add(record.id)
    out.push(record)
  }
  return out
}

export { parseArxivAtom }
