/**
 * BibTeX 构造与解析（文献库 02-文献/refs.bib）。
 *
 * 只从 LitRecord（真实检索记录）构造条目；不做任何"凭空补全"。
 * 条目使用 UTF-8（pandoc/biblatex/biber 现代工具链默认支持）。
 */

import type { LitRecord } from './lit-api.ts'

export interface BibEntry {
  readonly key: string
  readonly entry: string
}

function sanitizeKeyPart(text: string): string {
  // 保留拉丁字母/数字与中日韩汉字（UTF-8 bib key 由现代工具链支持）。
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '')
}

/** 作者姓氏：英文取最后一个词；中文（无空格）整体保留。 */
function authorKeyPart(author: string): string {
  const trimmed = author.trim()
  const parts = trimmed.split(/\s+/)
  const last = parts[parts.length - 1] ?? trimmed
  const s = sanitizeKeyPart(last)
  return s === '' ? sanitizeKeyPart(trimmed) : s
}

function titleKeyPart(title: string): string {
  // 中文标题：取全部汉字的前 4 个（稳定、确定性；冲突由 dedupeKey 处理）。
  const cjk = (title.match(/[\u4e00-\u9fff]+/g) ?? []).join('')
  if (cjk !== '') return cjk.slice(0, 4)
  const words = title.split(/\s+/).filter(w => !/^(a|an|the|on|of|for|and)$/i.test(w))
  for (const word of words) {
    const s = sanitizeKeyPart(word)
    if (s !== '') return s
  }
  return 'paper'
}

export function bibKeyFor(record: LitRecord): string {
  const author = record.authors[0] !== undefined ? authorKeyPart(record.authors[0]) : 'anon'
  const year = record.year ?? ''
  const title = titleKeyPart(record.title)
  return `${author}${year}${title}`.slice(0, 40)
}

function authorsField(authors: readonly string[]): string {
  return authors.map(a => a.trim()).filter(a => a !== '').join(' and ')
}

function optionalFields(record: LitRecord, extra: ReadonlyArray<readonly [string, string | undefined]>): string[] {
  const fields: string[] = []
  for (const [name, value] of extra) {
    if (value !== undefined && value !== '') fields.push(`  ${name} = {${value}}`)
  }
  if (record.doi !== undefined && record.doi !== '') fields.push(`  doi = {${record.doi}}`)
  if (record.url !== undefined && record.url !== '') fields.push(`  url = {${record.url}}`)
  return fields
}

export function buildBibtex(record: LitRecord, keyOverride?: string): BibEntry {
  const key = keyOverride ?? bibKeyFor(record)
  const author = authorsField(record.authors)
  const year = record.year ?? ''
  let entry: string
  switch (record.type) {
    case 'article':
      entry = `@article{${key},\n  author = {${author}},\n  title = {${record.title}},\n  journal = {${record.venue || 'unknown'}},\n  year = {${year}},\n${optionalFields(record, []).join(',\n')}\n}`
      break
    case 'inproceedings':
      entry = `@inproceedings{${key},\n  author = {${author}},\n  title = {${record.title}},\n  booktitle = {${record.venue || 'unknown'}},\n  year = {${year}},\n${optionalFields(record, []).join(',\n')}\n}`
      break
    case 'book':
      entry = `@book{${key},\n  author = {${author}},\n  title = {${record.title}},\n  publisher = {${record.venue || 'unknown'}},\n  year = {${year}},\n${optionalFields(record, []).join(',\n')}\n}`
      break
    case 'phdthesis':
      entry = `@phdthesis{${key},\n  author = {${author}},\n  title = {${record.title}},\n  school = {${record.venue || 'unknown'}},\n  year = {${year}},\n${optionalFields(record, []).join(',\n')}\n}`
      break
    case 'misc':
      entry = `@misc{${key},\n  author = {${author}},\n  title = {${record.title}},\n  howpublished = {${record.venue || 'Preprint'}},\n  year = {${year}},\n${optionalFields(record, []).join(',\n')}\n}`
      break
  }
  return { key, entry }
}

/** 提取 refs.bib 中已用的 key 集合。 */
export function parseBibKeys(bib: string): Set<string> {
  return new Set(parseBibKeysOrdered(bib))
}

/** 按出现顺序提取 key（GB/T 7714 顺序编码制下，条目顺序即引用编号）。 */
export function parseBibKeysOrdered(bib: string): string[] {
  const keys: string[] = []
  for (const m of bib.matchAll(/^@\w+\s*\{\s*([^,\s]+)/gm)) {
    if (m[1] !== undefined) keys.push(m[1])
  }
  return keys
}

/** 提取 refs.bib 中已收录的 DOI（小写），用于去重。 */
export function parseBibDois(bib: string): Set<string> {
  const dois = new Set<string>()
  for (const m of bib.matchAll(/doi\s*=\s*[{"]([^}"\s]+)[}"]/gi)) {
    if (m[1] !== undefined) dois.add(m[1].toLowerCase())
  }
  return dois
}

/** 给 key 加字母后缀直到不与现有 key 冲突。 */
export function dedupeKey(key: string, existing: ReadonlySet<string>): string {
  if (!existing.has(key)) return key
  const suffix = 'abcdefghijklmnopqrstuvwxyz'
  for (const letter of suffix) {
    const candidate = `${key}${letter}`
    if (!existing.has(candidate)) return candidate
  }
  return `${key}x${Math.random().toString(36).slice(2, 5)}`
}
