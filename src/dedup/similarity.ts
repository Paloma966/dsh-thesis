/**
 * 降重的核心度量：字符 n-gram 指纹（shingle）、倒排索引候选剪枝、
 * 包含率/杰卡德/最长公共子串（含起止偏移）。全部为纯函数、无随机。
 *
 * 口径说明（必须如实写进报告）：
 * - 指纹：归一化后按**字符**滑动窗口取 n 元组（`n = options.shingle`，
 *   中文 4 字、拉丁按 4 字符近似词），相同的 shingle 用稳定哈希比较。
 * - `containment`：本段 shingle 出现在对方中的比例 —— 回答"这段有多少是抄来的"；
 *   `jaccard`：双方 shingle 的交集/并集 —— 对长文档更保守。
 * - 命中定位：最长公共子串（归一化字符坐标），并回溯到原文偏移。
 * - 本模块**不是**知网/维普类系统：它只在给定语料内做字符串重合度估算，
 *   不能给出学校检测系统的重复率，也不接入任何收费库。
 *
 * @module dsh-thesis/dedup
 */

import type { NormalizedText, Segment } from './normalize.ts'
import { normalizeText, offsetsFor, sliceRaw } from './normalize.ts'

/** 带指纹的归一化文本（`chars` 是归一化字符数，索引用 `starts` 定位）。 */
export interface FingerprintedText {
  readonly text: string
  readonly chars: number
  /** shingle 哈希集合。 */
  readonly shingles: ReadonlySet<number>
  /** 第 i 个 shingle 在归一化字符坐标中的起点。 */
  readonly starts: readonly number[]
}

export interface ScoreOptions {
  /** shingle 窗口（字符数）。 */
  readonly shingle: number
  /** 命中片段的最短长度（归一化字符数），缺省 `2 × shingle`。 */
  readonly minRun?: number
  /** 最多返回多少条命中片段（按长度降序），缺省 5。 */
  readonly maxSpans?: number
}

/** 一条命中的连续片段（坐标是归一化字符坐标，`aStart`/`bStart` 对应各自文本）。 */
export interface MatchSpan {
  readonly length: number
  readonly aStart: number
  readonly aEnd: number
  readonly bStart: number
  readonly bEnd: number
}

export interface CompareResult {
  /** 综合得分：取 `containment`（本次实现保证 `score === containment`）。 */
  readonly score: number
  readonly containment: number
  readonly jaccard: number
  /** 最长公共子串长度（归一化字符数）。 */
  readonly longestRun: number
  readonly spans: readonly MatchSpan[]
}

/** 语料侧指纹计数（正文字符数口径，与段落长度无关）。 */
export interface CorpusDoc {
  readonly id: string
  readonly label: string
  readonly shingle: FingerprintedText
  /** 全局语料文档序号（用于倒排索引）。 */
  readonly index: number
}

export interface CorpusIndex {
  readonly docs: readonly CorpusDoc[]
  /** shingle 哈希 → 语料文档序号列表。 */
  readonly inverted: ReadonlyMap<number, readonly number[]>
}

export interface CorpusHit {
  readonly id: string
  readonly label: string
  readonly score: number
  readonly containment: number
  readonly jaccard: number
  readonly longestRun: number
  readonly spans: readonly CorpusSpan[]
}

/** 命中片段 + 回溯到原文的片段文本与行号。 */
export interface CorpusSpan {
  readonly length: number
  /** 本段原文中的片段（自 `segment.text` 切出）。 */
  readonly text: string
  /** 片段在 `segment.text` 中的起止偏移（`[start, end)`）。 */
  readonly start: number
  readonly end: number
  readonly lineStart: number
  readonly lineEnd: number
}

export interface RiskItem {
  readonly segment: Segment
  readonly best: CorpusHit
  /** 该段的全部候选命中（按得分降序，含 best）。 */
  readonly hits: readonly CorpusHit[]
}

export interface ScanOptions extends ScoreOptions {
  /** 判定高风险的包含率阈值。 */
  readonly threshold: number
}

export interface ScanResult {
  readonly items: readonly RiskItem[]
  /** 参与比对的正文段落数。 */
  readonly paragraphCount: number
  /** 参与比对段落的归一化字符总数（加权重复率的分母）。 */
  readonly totalChars: number
  readonly corpusCount: number
  /** 有任一非零命中的段落数。 */
  readonly matchedCount: number
  readonly high: number
  readonly medium: number
  readonly low: number
}

// ---------------------------------------------------------------------------
// 指纹
// ---------------------------------------------------------------------------

/**
 * 稳定 32 位哈希（FNV-1a 变体）。自行实现而不依赖 node:crypto，
 * 保证"同一输入 → 同一哈希"，跨语言/跨版本可复现。
 */
export function hashShingle(text: string): number {
  let hash = 0x811C9DC5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/**
 * 对**已归一化**的文本取字符 n-gram 指纹。
 * 文本短于窗口时退化为「整串一个 shingle」，使 `containment` 仍有定义。
 */
export function fingerprintText(doc: NormalizedText, shingle: number): FingerprintedText {
  const n = Math.max(1, Math.floor(shingle))
  const chars = doc.chars.map(c => c.ch)
  const shingles = new Set<number>()
  const starts: number[] = []
  if (chars.length === 0) {
    return { text: doc.text, chars: 0, shingles, starts }
  }
  if (chars.length <= n) {
    shingles.add(hashShingle(chars.join('')))
    starts.push(0)
    return { text: doc.text, chars: chars.length, shingles, starts }
  }
  for (let i = 0; i + n <= chars.length; i += 1) {
    const shingleText = chars.slice(i, i + n).join('')
    const hash = hashShingle(shingleText)
    if (!shingles.has(hash)) {
      shingles.add(hash)
      starts.push(i)
    }
  }
  return { text: doc.text, chars: chars.length, shingles, starts }
}

/** 段落 → 指纹。 */
export function fingerprintSegment(segment: Segment, shingle: number): FingerprintedText {
  return fingerprintText(segment.doc, shingle)
}

/** 原始文本 → 指纹（内部先归一化，便于直接比较任意字符串）。 */
export function fingerprintOf(text: string, shingle: number): FingerprintedText {
  return fingerprintText(normalizeText(text), shingle)
}

/** 两个集合的交集大小（迭代较小者）。 */
export function intersectionSize(a: ReadonlySet<number>, b: ReadonlySet<number>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  let count = 0
  for (const value of small) {
    if (large.has(value)) count += 1
  }
  return count
}

// ---------------------------------------------------------------------------
// 倒排索引
// ---------------------------------------------------------------------------

/** 用语料建立倒排索引：shingle → 语料文档序号列表。 */
export function buildIndex(docs: readonly CorpusDoc[]): CorpusIndex {
  const inverted = new Map<number, number[]>()
  for (const doc of docs) {
    for (const shingle of doc.shingle.shingles) {
      const list = inverted.get(shingle)
      if (list === undefined) {
        inverted.set(shingle, [doc.index])
      } else {
        list.push(doc.index)
      }
    }
  }
  return { docs, inverted }
}

// ---------------------------------------------------------------------------
// 度量
// ---------------------------------------------------------------------------

/**
 * 从共同 shingle 出发向两侧扩展，求最长的连续公共子串（片段起点是区间起点）。
 * 复杂度 O(片段长度)，用于把「有重合」细化成「抄了哪一段」。
 */
function expand(a: string, b: string, i: number, j: number): { length: number; aStart: number; bStart: number } {
  let aStart = i
  let bStart = j
  while (aStart > 0 && bStart > 0 && a[aStart - 1] === b[bStart - 1]) {
    aStart -= 1
    bStart -= 1
  }
  let length = 0
  let x = aStart
  let y = bStart
  while (x < a.length && y < b.length && a[x] === b[y]) {
    x += 1
    y += 1
    length += 1
  }
  return { length, aStart, bStart }
}

/**
 * 找出全部足够长的公共片段（按长度降序，去掉被更长片段覆盖的短片段）。
 * 同长度片段按 (aStart, bStart) 稳定排序，保证可复现。
 */
export function matchSpans(
  a: FingerprintedText,
  b: FingerprintedText,
  options: { shingle: number; minRun?: number; maxSpans?: number },
): MatchSpan[] {
  const minRun = Math.max(1, Math.floor(options.minRun ?? Math.max(2, options.shingle * 2)))
  const maxSpans = Math.max(1, Math.floor(options.maxSpans ?? 5))
  const aChars = a.text
  const bChars = b.text
  if (aChars.length === 0 || bChars.length === 0) return []
  const seen = new Set<string>()
  const spans: MatchSpan[] = []
  const narrow = a.shingles.size <= b.shingles.size ? a : b
  for (const start of narrow.starts) {
    const probe = narrow.text.slice(start, start + Math.max(1, options.shingle))
    const other = narrow === a ? b : a
    let from = 0
    for (;;) {
      const at = other.text.indexOf(probe, from)
      if (at < 0) break
      const aIdx = narrow === a ? start : at
      const bIdx = narrow === a ? at : start
      const grown = expand(aChars, bChars, aIdx, bIdx)
      from = at + 1
      if (grown.length < minRun) continue
      const key = `${grown.aStart}:${grown.bStart}:${grown.length}`
      if (seen.has(key)) continue
      seen.add(key)
      spans.push({
        length: grown.length,
        aStart: grown.aStart,
        aEnd: grown.aStart + grown.length,
        bStart: grown.bStart,
        bEnd: grown.bStart + grown.length,
      })
    }
  }
  spans.sort((x, y) => y.length - x.length || x.aStart - y.aStart || x.bStart - y.bStart)
  const kept: MatchSpan[] = []
  for (const span of spans) {
    if (kept.length >= maxSpans) break
    const covered = kept.some(k =>
      k.aStart <= span.aStart && k.bStart <= span.bStart
      && k.aStart + k.length >= span.aStart + span.length
      && k.bStart + k.length >= span.bStart + span.length)
    if (!covered) kept.push(span)
  }
  return kept
}

/** 比较两份指纹：包含率、杰卡德、最长公共子串与命中片段。 */
export function compareFingerprints(a: FingerprintedText, b: FingerprintedText, options: { shingle: number; minRun?: number; maxSpans?: number }): CompareResult {
  const intersection = intersectionSize(a.shingles, b.shingles)
  const containment = a.shingles.size === 0 ? 0 : intersection / a.shingles.size
  const union = a.shingles.size + b.shingles.size - intersection
  const jaccard = union === 0 ? 0 : intersection / union
  const spans = matchSpans(a, b, options)
  const longestRun = spans.length > 0 ? spans[0]!.length : 0
  return { score: containment, containment, jaccard, longestRun, spans }
}

/**
 * 比较两段文本。返回 `{ score, containment, jaccard, longestRun, spans }`；
 * `spans` 的坐标是**归一化字符坐标**，调用方可配合 `offsetsFor` 回到原文。
 */
export function compareText(a: string, b: string, options: ScoreOptions): CompareResult {
  const fa = fingerprintOf(a, options.shingle)
  const fb = fingerprintOf(b, options.shingle)
  const scoreOptions: { shingle: number; minRun?: number; maxSpans?: number } = { shingle: options.shingle }
  if (options.minRun !== undefined) scoreOptions.minRun = options.minRun
  if (options.maxSpans !== undefined) scoreOptions.maxSpans = options.maxSpans
  return compareFingerprints(fa, fb, scoreOptions)
}

// ---------------------------------------------------------------------------
// 扫描
// ---------------------------------------------------------------------------

/** 可选的两两朴素比对（结果必须与倒排索引一致，供等价性测试与排查使用）。 */
export type CandidateMode = 'index' | 'all'

export interface ScanInput {
  readonly segments: readonly Segment[]
  readonly corpus: readonly { readonly id: string; readonly label: string; readonly text: string }[]
  readonly options: ScanOptions
  /** 候选策略：index（默认，倒排剪枝）| all（与全语料两两比对）。 */
  readonly candidateMode?: CandidateMode
}

function documentFor(text: string, shingle: number): FingerprintedText {
  return fingerprintOf(text, shingle)
}

function spansFor(segment: Segment, result: CompareResult): CorpusSpan[] {
  const spans: CorpusSpan[] = []
  for (const span of result.spans) {
    const mapped = offsetsFor(segment.doc, span.aStart, span.aEnd)
    if (mapped === null) continue
    const text = sliceRaw(segment.text, mapped.start, mapped.end)
    spans.push({
      length: span.length,
      text,
      start: mapped.start,
      end: mapped.end,
      lineStart: lineAtSafe(segment, mapped.start),
      lineEnd: lineAtSafe(segment, mapped.end),
    })
  }
  return spans
}

function lineAtSafe(segment: Segment, offset: number): number {
  const clamped = Math.max(0, Math.min(segment.text.length, offset))
  let line = segment.lineStart
  for (let i = 0; i < clamped; i += 1) {
    if (segment.text[i] === '\n') line += 1
  }
  return line
}

/**
 * 扫描正文段落：每段给出最佳命中（来源 id、得分、命中片段偏移与文本）。
 *
 * 候选剪枝：先用倒排索引筛出与本段有任何共同 shingle 的语料文档；
 * 没有任何共同 shingle 的文档，其 `containment` 必然为 0（本段没有被它覆盖），
 * 因此不会被选为最佳命中 —— 这正是剪枝不改变结果的原因。
 *
 * **自比屏蔽**：语料文档 id 与本段 `file` 相同的一律跳过。默认语料含各章正文
 * （正文互查），若不跳过，段落与它所在的那一章必然 100% 重合——那是"自己跟
 * 自己比"，不是重复。判断按文件路径做，两种候选策略下行为一致。
 */
export function scan(input: ScanInput): ScanResult {
  const options = input.options
  const corpusDocs: CorpusDoc[] = input.corpus.map((entry, index) => ({
    id: entry.id,
    label: entry.label,
    shingle: documentFor(entry.text, options.shingle),
    index,
  }))
  const corpusIndex = buildIndex(corpusDocs)
  const items: RiskItem[] = []
  let high = 0
  let medium = 0
  let low = 0
  let matched = 0
  let totalChars = 0

  for (const segment of input.segments) {
    totalChars += segment.doc.chars.length
    const target = fingerprintSegment(segment, options.shingle)
    const candidates = candidateIds(target, corpusIndex, input.candidateMode ?? 'index')
    const selfId = segment.file.replace(/\\/g, '/')
    const hits: CorpusHit[] = []
    for (const candidate of candidates) {
      const doc = corpusDocs[candidate]!
      if (doc.id.replace(/\\/g, '/') === selfId) continue
      const result = compareFingerprints(target, doc.shingle, {
        shingle: options.shingle,
        ...(options.minRun !== undefined ? { minRun: options.minRun } : {}),
        ...(options.maxSpans !== undefined ? { maxSpans: options.maxSpans } : {}),
      })
      if (result.score <= 0) continue
      hits.push({
        id: doc.id,
        label: doc.label,
        score: result.score,
        containment: result.containment,
        jaccard: result.jaccard,
        longestRun: result.longestRun,
        spans: spansFor(segment, result),
      })
    }
    hits.sort((x, y) => y.score - x.score || y.longestRun - x.longestRun || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
    const best = hits[0]
    if (best === undefined) {
      low += 1
      continue
    }
    matched += 1
    if (best.score >= options.threshold) high += 1
    else if (best.score >= options.threshold * 0.6) medium += 1
    else low += 1
    items.push({ segment, best, hits })
  }

  items.sort((x, y) => y.best.score - x.best.score
    || y.best.longestRun - x.best.longestRun
    || (x.segment.file < y.segment.file ? -1 : x.segment.file > y.segment.file ? 1 : 0)
    || x.segment.lineStart - y.segment.lineStart)

  return {
    items,
    paragraphCount: input.segments.length,
    totalChars,
    corpusCount: input.corpus.length,
    matchedCount: matched,
    high,
    medium,
    low,
  }
}

function candidateIds(target: FingerprintedText, index: CorpusIndex, mode: CandidateMode): number[] {
  if (mode === 'all') return index.docs.map(doc => doc.index)
  const ids = new Set<number>()
  for (const shingle of target.shingles) {
    const list = index.inverted.get(shingle)
    if (list === undefined) continue
    for (const id of list) ids.add(id)
  }
  return [...ids].sort((a, b) => a - b)
}
