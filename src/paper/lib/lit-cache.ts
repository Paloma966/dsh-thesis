/**
 * 文献检索缓存与检索留痕（02-文献/.lit-cache.json 与 02-文献/检索记录.md）。
 *
 * 缓存是"零假文献"的机制保证：thesis_lit_save 只接受缓存中由真实检索
 * 产生的记录 ID，不接受模型转述的元数据。
 */

import * as nodePath from 'node:path'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { describeReadFailure, isMissingError } from '../../shared/fs-errors.ts'
import type { LitRecord } from './lit-api.ts'

export const LIT_CACHE_REL = '02-文献/.lit-cache.json'
export const LIT_RECORD_REL = '02-文献/检索记录.md'
export const REFS_BIB_REL = '02-文献/refs.bib'
export const NOTES_DIR_REL = '02-文献/笔记'

export interface LitCache {
  readonly version: 1
  readonly records: Record<string, LitRecord>
}

export function emptyCache(): LitCache {
  return { version: 1, records: {} }
}

/**
 * 读取检索缓存。
 *
 * **只有「缓存文件不存在」才返回空缓存**（第一次检索的正常情况）。
 * 其余情况一律抛错：
 * - 读失败（权限 / IO）：抛错并说明「缓存存在但读不出来」，否则调用方会用空缓存
 *   覆盖写回，把**全部历史检索记录**抹掉——那些记录是「零假文献」红线的审计证据；
 * - JSON 损坏 / 版本不符：同样抛错，并提示备份后重建。
 */
export async function loadCache(fs: FileSystem, root: string, signal?: AbortSignal): Promise<LitCache> {
  const path = nodePath.join(root, LIT_CACHE_REL)
  let raw: string
  try {
    raw = await fs.readText(await fs.resolve(path, { signal }), signal)
  } catch (error) {
    if (isMissingError(error)) return emptyCache()
    throw new Error(describeReadFailure('文献检索缓存', path, error, signal))
  }
  let parsed: LitCache
  try {
    parsed = JSON.parse(raw) as LitCache
  } catch (error) {
    throw new Error(
      `文献检索缓存不是合法 JSON：${path}（${error instanceof Error ? error.message : String(error)}）。`
      + '为避免把历史检索记录改成空缓存，已停止本次操作。请备份该文件后删除它，再重新检索。',
    )
  }
  if (parsed === null || typeof parsed !== 'object' || parsed.version !== 1
    || typeof parsed.records !== 'object' || parsed.records === null) {
    throw new Error(
      `文献检索缓存的版本或结构不符：${path}（期望 version: 1 与 records 对象）。`
      + '为避免覆盖历史检索记录，已停止本次操作。请备份后删除该文件，再重新检索。',
    )
  }
  return parsed
}

export async function saveCache(fs: FileSystem, root: string, cache: LitCache, signal?: AbortSignal): Promise<void> {
  await fs.writeText(
    await fs.resolve(nodePath.join(root, LIT_CACHE_REL), { signal }),
    JSON.stringify(cache, null, 2) + '\n',
    undefined,
    signal,
  )
}

export function mergeRecords(cache: LitCache, records: readonly LitRecord[]): LitCache {
  const next: Record<string, LitRecord> = { ...cache.records }
  for (const record of records) next[record.id] = record
  return { version: 1, records: next }
}

const RECORD_HEADER = `# 文献检索记录

> 每次检索留痕：哪个库、什么关键词、命中多少、收录哪些。
> 这是"零假文献"的审计证据。

| 日期 | 动作 | 数据库 | 关键词/文献 | 命中 | 备注 |
|---|---|---|---|---|---|
`

export async function appendLitRecord(fs: FileSystem, root: string, row: string, signal?: AbortSignal): Promise<void> {
  const path = nodePath.join(root, LIT_RECORD_REL)
  let raw: string
  try {
    raw = await fs.readText(await fs.resolve(path, { signal }), signal)
  } catch (error) {
    // 只有「检索记录还没建过」才用表头开始；读失败必须上抛，否则会抹掉审计证据。
    if (!isMissingError(error)) throw new Error(describeReadFailure('文献检索记录', path, error, signal))
    raw = RECORD_HEADER
  }
  if (raw.trim() === '') raw = RECORD_HEADER
  await fs.writeText(await fs.resolve(path, { signal }), `${raw.trimEnd()}\n${row}\n`, undefined, signal)
}

export function searchRow(date: string, source: string, query: string, hits: number, ids: readonly string[]): string {
  const note = hits > 0 ? `缓存 id：${ids.join('、')}` : '无结果'
  return `| ${date} | 检索 | ${source} | ${query.replaceAll('|', '\\|')} | ${hits} | ${note} |`
}

export function saveRow(date: string, source: string, title: string, bibKey: string, doi?: string): string {
  const note = `收录 → refs.bib [${bibKey}]${doi !== undefined ? `（DOI: ${doi}）` : ''}`
  return `| ${date} | 收录 | ${source} | ${title.replaceAll('|', '\\|')} | 1 | ${note} |`
}
