/**
 * 文献三工具：thesis_lit_search / thesis_lit_save / thesis_lit_note。
 *
 * 机制保证"零假文献"：
 * - search 只返回真实 API 检索结果，并把结果写入检索缓存（.lit-cache.json）；
 * - save 只接受缓存中的记录 id，元数据零转述，写 refs.bib 并留审计行；
 * - note 基于缓存或 refs.bib 生成笔记骨架。
 */

import * as nodePath from 'node:path'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { describeReadFailure, isMissingError } from '../../shared/fs-errors.ts'
import {
  searchLiterature,
  LIT_SOURCES,
  type FetchLike,
  type LitRecord,
  type LitSource,
} from '../lib/lit-api.ts'
import {
  appendLitRecord,
  loadCache,
  mergeRecords,
  NOTES_DIR_REL,
  REFS_BIB_REL,
  saveCache,
  saveRow,
  searchRow,
} from '../lib/lit-cache.ts'
import { bibKeyFor, buildBibtex, dedupeKey, parseBibDois, parseBibKeys } from '../lib/bibtex.ts'
import { findThesisRoot } from '../lib/project.ts'

const BIB_HEADER = `% 文献库（BibTeX）。
% 红线：本文件只收录真实检索到的文献（由 thesis_lit_search/save 写入）。
% 每条必须含 DOI 或 URL。引用格式遵循 GB/T 7714-2015（顺序编码制）。

`

export interface LitSearchArgs {
  query: string
  year_from?: number
  limit?: number
  source?: LitSource
}

export interface LitSaveArgs {
  ids: string[]
}

export interface LitNoteArgs {
  ref: string
  force?: boolean
}

async function thesisRoot(fs: FileSystem, cwd: string | undefined, signal?: AbortSignal): Promise<string> {
  const root = await findThesisRoot(fs, cwd, signal)
  if (root === null) {
    throw new Error('未找到论文工作区（向上查找 00-管理/进度台账.md 失败）。请先用 thesis_init 创建工作区，或在论文仓库目录内操作。')
  }
  return root
}

function displayAuthors(authors: readonly string[], max = 3): string {
  if (authors.length === 0) return '（无作者信息）'
  const head = authors.slice(0, max).join(', ')
  return authors.length > max ? `${head} 等` : head
}

function displayRecord(record: LitRecord): string {
  const lines: string[] = []
  lines.push(`【${record.id}】${record.title}`)
  lines.push(`  作者：${displayAuthors(record.authors)}；年份：${record.year ?? '未知'}；出处：${record.venue || '未知'}`)
  if (record.doi !== undefined) lines.push(`  DOI：${record.doi}`)
  if (record.url !== undefined) lines.push(`  URL：${record.url}`)
  if (record.citationCount !== undefined) lines.push(`  被引：${record.citationCount}`)
  if (record.abstract !== undefined) lines.push(`  摘要：${record.abstract}`)
  return lines.join('\n')
}

export async function runLitSearch(
  fs: FileSystem,
  args: LitSearchArgs,
  cwd: string | undefined,
  signal: AbortSignal | undefined,
  fetchImpl: FetchLike,
): Promise<string> {
  if (args.query === undefined || args.query.trim() === '') throw new Error('query 必填：检索关键词（中英文均可）。')
  const root = await thesisRoot(fs, cwd, signal)
  const results = await searchLiterature(fetchImpl, {
    query: args.query.trim(),
    ...(args.year_from !== undefined ? { yearFrom: args.year_from } : {}),
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
    ...(args.source !== undefined ? { source: args.source } : {}),
    signal,
  })
  const cache = mergeRecords(await loadCache(fs, root, signal), results)
  await saveCache(fs, root, cache, signal)
  const date = new Date().toISOString().slice(0, 10)
  await appendLitRecord(fs, root, searchRow(date, results[0]!.source, args.query.trim(), results.length, results.map(r => r.id)), signal)

  const lines: string[] = []
  lines.push(`检索「${args.query.trim()}」命中 ${results.length} 条（来源：${results[0]!.source}），已写入检索缓存与检索记录。`)
  lines.push('')
  results.slice(0, args.limit ?? 10).forEach(r => {
    lines.push(displayRecord(r))
    lines.push('')
  })
  lines.push('下一步：选定文献后用 thesis_lit_save（ids: [记录 id]）收录进 refs.bib；再用 thesis_lit_note 生成阅读笔记。')
  return lines.join('\n')
}

export async function runLitSave(fs: FileSystem, args: LitSaveArgs, cwd: string | undefined, signal?: AbortSignal): Promise<string> {
  if (args.ids === undefined || args.ids.length === 0) throw new Error('ids 必填：thesis_lit_search 返回的记录 id 列表。')
  const root = await thesisRoot(fs, cwd, signal)
  const cache = await loadCache(fs, root, signal)

  let bib: string
  try {
    bib = await fs.readText(await fs.resolve(nodePath.join(root, REFS_BIB_REL), { signal }), signal)
  } catch (error) {
    // 只有「文献库还没建过」才从表头开始。读失败（权限/IO）时必须停下：
    // 否则会在「假设文献库是空的」前提下写回，等于删掉学生已有的全部文献。
    if (!isMissingError(error)) {
      throw new Error(describeReadFailure('文献库（02-文献/refs.bib）', nodePath.join(root, REFS_BIB_REL), error, signal))
    }
    bib = BIB_HEADER
  }
  if (bib.trim() === '') bib = BIB_HEADER

  const keys = parseBibKeys(bib)
  const dois = parseBibDois(bib)
  const date = new Date().toISOString().slice(0, 10)
  const outcomes: string[] = []
  let added = 0

  for (const id of args.ids) {
    const record: LitRecord | undefined = cache.records[id]
    if (record === undefined) {
      outcomes.push(`✗ ${id}：不在检索缓存中。缓存只包含真实检索结果；请先用 thesis_lit_search 检索，不要手工构造元数据。`)
      continue
    }
    if (record.doi !== undefined && dois.has(record.doi.toLowerCase())) {
      outcomes.push(`⏭ ${record.title}：DOI 已在 refs.bib 中，跳过。`)
      continue
    }
    const finalKey = dedupeKey(bibKeyFor(record), keys)
    keys.add(finalKey)
    if (record.doi !== undefined) dois.add(record.doi.toLowerCase())
    const { entry } = buildBibtex(record, finalKey)
    bib += `${entry}\n\n`
    await appendLitRecord(fs, root, saveRow(date, record.source, record.title, finalKey, record.doi), signal)
    outcomes.push(`✓ ${record.title} → refs.bib [${finalKey}]`)
    added += 1
  }

  await fs.writeText(await fs.resolve(nodePath.join(root, REFS_BIB_REL), { signal }), bib, undefined, signal)
  outcomes.push('', `本次收录 ${added}/${args.ids.length} 条。`)
  return outcomes.join('\n')
}

// ---------------------------------------------------------------------------
// 笔记
// ---------------------------------------------------------------------------

function noteTemplate(record: LitRecord, bibKey: string): string {
  const authorText = record.authors.length === 0 ? '（无作者信息）' : displayAuthors(record.authors)
  const meta: string[] = [`收录于 refs.bib [${bibKey}]`]
  if (record.doi !== undefined) meta.push(`DOI：${record.doi}`)
  if (record.url !== undefined) meta.push(`URL：${record.url}`)
  if (record.citationCount !== undefined) meta.push(`被引 ${record.citationCount} 次`)
  return `# ${record.title}（${authorText}，${record.year ?? '年份未知'}，${record.venue || '出处未知'}）

> ${meta.join('；')}
> 笔记模板见技能 thesis-literature；写论文时从这里取"可用引用句"。

## 这篇解决什么问题

（待补）

## 方法/技术要点（3-5 条，用自己的话）

（待补）

## 实验与结论（数据集/指标/结果）

（待补）

## 与我课题的关系

（待补：借鉴什么 / 对比什么 / 差异在哪）

## 可用引用句

（待补：1-2 句，注明放哪一章）

## 摘要（原始）

${record.abstract ?? '（检索记录无摘要；请从原文自行摘录）'}
`
}

/** 从 refs.bib 中按 key 提取最小记录（供 note 在缓存缺失时使用）。 */
function findRecordByBibKey(bib: string, key: string): LitRecord | undefined {
  const m = new RegExp(`^@(\\w+)\\s*\\{\\s*${key}\\s*,\\s*([\\s\\S]*?)\\n\\}`, 'm').exec(bib)
  if (m === null) return undefined
  const body = m[2] ?? ''
  const field = (name: string): string | undefined => {
    const fm = new RegExp(`^\\s*${name}\\s*=\\s*\\{([\\s\\S]*?)\\}`, 'm').exec(body)
    return fm?.[1]?.trim()
  }
  const authorRaw = field('author')
  const authors = authorRaw === undefined ? [] : authorRaw.split(/\s+and\s+/).map(a => a.trim()).filter(a => a !== '')
  const title = field('title') ?? '（未知标题）'
  const yearRaw = field('year')
  const year = yearRaw === undefined || yearRaw === '' ? null : Number.parseInt(yearRaw, 10)
  const doi = field('doi')
  const url = field('url')
  const typeMap: Record<string, LitRecord['type']> = { article: 'article', inproceedings: 'inproceedings', book: 'book', phdthesis: 'phdthesis' }
  return {
    id: '',
    title,
    authors,
    year: Number.isNaN(year) ? null : year,
    venue: field('journal') ?? field('booktitle') ?? field('school') ?? field('publisher') ?? field('howpublished') ?? '',
    type: typeMap[m[1] ?? ''] ?? 'misc',
    ...(doi !== undefined ? { doi } : {}),
    ...(url !== undefined ? { url } : {}),
    source: 'refs.bib',
  }
}

export async function runLitNote(fs: FileSystem, args: LitNoteArgs, cwd: string | undefined, signal?: AbortSignal): Promise<string> {
  if (args.ref === undefined || args.ref.trim() === '') throw new Error('ref 必填：缓存记录 id（thesis_lit_search 返回）或 refs.bib 条目 key。')
  const root = await thesisRoot(fs, cwd, signal)
  const ref = args.ref.trim()

  let record: LitRecord | undefined
  let bibKey: string
  const cache = await loadCache(fs, root, signal)
  if (cache.records[ref] !== undefined) {
    record = cache.records[ref]
    bibKey = bibKeyFor(record)
  } else {
    let bib: string
    try {
      bib = await fs.readText(await fs.resolve(nodePath.join(root, REFS_BIB_REL), { signal }), signal)
    } catch (error) {
      if (!isMissingError(error)) {
        throw new Error(describeReadFailure('文献库（02-文献/refs.bib）', nodePath.join(root, REFS_BIB_REL), error, signal))
      }
      throw new Error(`记录 ${ref} 既不在检索缓存、refs.bib 也不存在。请先用 thesis_lit_search 检索。`)
    }
    const byKey = findRecordByBibKey(bib, ref)
    if (byKey === undefined) {
      throw new Error(`记录 ${ref} 不在检索缓存中，refs.bib 中也没有该 key。请先用 thesis_lit_search 检索。`)
    }
    record = byKey
    bibKey = ref
  }

  const notePath = nodePath.join(root, NOTES_DIR_REL, `${bibKey}.md`)
  try {
    await fs.readText(await fs.resolve(notePath, { signal }), signal)
    if (args.force !== true) throw new Error(`笔记已存在：${notePath}。如确需覆盖，请设 force: true。`)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('笔记已存在')) throw error
    // 不存在：继续创建。
  }

  await fs.writeText(await fs.resolve(notePath, { signal }), noteTemplate(record, bibKey), undefined, signal)
  return `笔记骨架已创建：${notePath}\n下一步：读原文，补全"方法/技术要点"与"与我课题的关系"两节（见技能 thesis-literature）。`
}

export { LIT_SOURCES }
