/**
 * 材料摄取模块门面：类型判定 → 各格式抽取 → 统一的 `thesis_ingest` 工具。
 *
 * 设计要点：
 * - `extractDocument` 是**纯函数**（字节 + 类型 + 选项 → 结果），不碰磁盘；
 * - `extractText` 是统一入口（按文件名判定类型），供其它模块编程调用；
 * - `thesis_ingest` 负责磁盘/工作区落盘：读文件（二进制走 `node:fs` 例外）、
 *   递归枚举目录、把摘要写到 `00-管理/材料/`，**绝不覆盖已存在的摘要**；
 * - I/O 通过 {@link IngestIO} 注入，便于测试注入自定义读取器与假文件系统。
 *
 * @module dsh-thesis/ingest
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import * as nodePath from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { IngestOptions } from '../config.ts'
import { findThesisRoot } from '../paper/lib/project.ts'
import { bulletList, definePaperTool, sessionCwd, textOutput } from '../shared/index.ts'
import { ingestCommand } from './commands.ts'
import {
  codeLanguageOf,
  detectTechStack,
  isManifestFile,
  renderProjectSummary,
  summarizeSource,
  type CodeFileSummary,
  type CodeLanguage,
} from './code.ts'
import { extractDocx } from './docx.ts'
import { extractPdf } from './pdf.ts'
import { extractPptx } from './pptx.ts'
import { decodeTextBytes, extractText as extractPlainText } from './text.ts'
import type { ExtractResult } from './types.ts'
import { extractXlsx } from './xlsx.ts'

// ---------------------------------------------------------------------------
// 类型判定
// ---------------------------------------------------------------------------

/** 统一的门面输出（`shared/textOutput`）：模型看到的就是这段字符串。 */
const OUTPUT = textOutput()

/** 摄取类型：可抽取的文档格式 + 源码结构摘要 + 不支持。 */
export type IngestKind = 'docx' | 'xlsx' | 'pptx' | 'pdf' | 'text' | 'code' | 'unsupported'

/** 文本类扩展名（含 `.html`，抽取时去标签）。 */
const TEXT_EXTENSIONS = [
  '.md', '.markdown', '.txt', '.csv', '.tsv', '.json', '.yaml', '.yml',
  '.bib', '.ris', '.html', '.htm',
]

/** 旧版二进制 Office 格式：明确不支持并给出另存为提示。 */
const LEGACY_EXTENSIONS = ['.doc', '.xls', '.ppt']

/** 递归枚举时跳过的目录名（版本库/依赖/产出，避免把仓库翻个底朝天）。 */
export const SKIP_DIRS = ['node_modules', '.git', '06-论文/产出', '产出', '.paper', 'dist', 'lib', '__pycache__', '.venv', 'venv']

/**
 * 按扩展名判定摄取类型。
 *
 * 顺序有讲究：源码扩展名先判为 `code`（`.md/.json/.yaml/.html` 仍走 `text`，
 * 依赖清单也走 `text`——清单原文对写"技术选型"有用）。
 */
export function detectKind(path: string): IngestKind {
  const lower = path.toLowerCase().replace(/\\/g, '/')
  const base = lower.slice(lower.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  const extension = dot <= 0 ? '' : base.slice(dot)
  if (extension === '.docx' || extension === '.docm') return 'docx'
  if (extension === '.xlsx' || extension === '.xlsm') return 'xlsx'
  if (extension === '.pptx' || extension === '.pptm') return 'pptx'
  if (extension === '.pdf') return 'pdf'
  if (isManifestFile(path)) return 'text'
  // `.html/.htm/.md/.json/.yaml` 等仍按文本读（HTML 另有去标签处理）：
  // 它们虽然是"代码风格"的文件，但作为材料时原文更有用。
  if (TEXT_EXTENSIONS.includes(extension)) return 'text'
  if (codeLanguageOf(path) !== undefined) return 'code'
  // 旧版二进制格式：判为 unsupported，但调用方在目录枚举时仍会收进来，
  // 以便给出"请另存为新格式"的明确提示（见 unsupportedReason）。
  if (LEGACY_EXTENSIONS.includes(extension)) return 'unsupported'
  return 'unsupported'
}

/** 不支持时的解释（`.doc`/`.xls`/`.ppt` 走专门提示）。 */
export function unsupportedReason(path: string): string {
  const lower = path.toLowerCase()
  const extension = lower.slice(lower.lastIndexOf('.'))
  if (LEGACY_EXTENSIONS.includes(extension)) {
    return `${extension} 是 1997–2003 的旧二进制 Office 格式，本模块无法读取：请在 Word/Excel/PPT 或 WPS 里「另存为」.${extension.slice(1)}x 新格式后重试。`
  }
  return '不支持的文件类型：可摄取的格式为 docx / xlsx / pptx / pdf / md / txt / csv / tsv / json / yaml / bib / ris / html。'
}

// ---------------------------------------------------------------------------
// 统一抽取
// ---------------------------------------------------------------------------

/** 抽取结果（工具与其它模块共用的公开形状）。 */
export interface IngestExtract {
  /** 是否抽取成功。 */
  readonly ok: boolean
  /** 判定出的类型。 */
  readonly kind: IngestKind
  /** 抽取到的文本（失败时为空串）。 */
  readonly text: string
  /** 文本字符数。 */
  readonly chars: number
  /** 是否因 `maxChars` 截断。 */
  readonly truncated: boolean
  /** 文档标题（docx/pptx 的文档属性）。 */
  readonly title?: string
  /** 说明/失败原因。 */
  readonly note?: string
  /** 低置信标记（文本量明显偏少）。 */
  readonly lowConfidence?: boolean
}

/** 把内部结果 + 类型包装成公开结果。 */
function wrap(kind: IngestKind, result: ExtractResult): IngestExtract {
  return {
    ok: result.ok,
    kind,
    text: result.ok ? result.text : '',
    chars: result.ok ? result.text.length : 0,
    truncated: result.truncated,
    ...(result.title !== undefined ? { title: result.title } : {}),
    ...(result.note !== undefined ? { note: result.note } : {}),
    ...(result.lowConfidence === true ? { lowConfidence: true } : {}),
  }
}

/**
 * 按类型抽取字节 → 文本（纯函数）。
 *
 * - `unsupported` 返回 `ok: false` 与明确的另存为提示，绝不静默返回空文本；
 * - `code` **不返回源码正文**，只给该文件的结构摘要（语言/行数/声明）。
 */
export function extractDocument(bytes: Uint8Array, kind: IngestKind, options: { maxChars: number }): IngestExtract {
  switch (kind) {
    case 'docx':
      return wrap(kind, extractDocx(bytes, options))
    case 'xlsx':
      return wrap(kind, extractXlsx(bytes, options))
    case 'pptx':
      return wrap(kind, extractPptx(bytes, options))
    case 'pdf':
      return wrap(kind, extractPdf(bytes, options))
    case 'text':
      return wrap(kind, extractPlainText(bytes, 'material.txt', options))
    case 'code':
      return codeFileExtract('material.ts', decodeTextBytes(bytes), options)
    default:
      return { ok: false, kind: 'unsupported', text: '', chars: 0, truncated: false, note: unsupportedReason('') }
  }
}

/** 单文件代码结构摘要（不返回源码正文）。 */
export function codeFileExtract(rel: string, text: string, options: { maxChars: number }): IngestExtract {
  const summary = summarizeSource(rel, text)
  const declarations = summary.declarations.length === 0
    ? '（未检出顶层声明）'
    : summary.declarations.map(item => `${item.kind} ${item.name}（第 ${item.line} 行）`).join('；')
  const body = [
    `文件：${summary.rel}`,
    `语言：${summary.language}`,
    `行数：${summary.lines}（代码 ${summary.codeLines}，注释 ${summary.commentLines}，空行 ${summary.blankLines}）`,
    `主要声明：${declarations}`,
    ...(summary.truncated ? ['（文件过长，声明索引已截断）'] : []),
  ].join('\n')
  const limited = body.length > options.maxChars
    ? `${body.slice(0, Math.max(0, options.maxChars - 16))}\n…（摘要已截断）`
    : body
  return {
    ok: true,
    kind: 'code',
    text: limited,
    chars: limited.length,
    truncated: limited.length < body.length,
    note: '这是**结构摘要**，不含源码正文：写"系统实现"章与答辩素材时请基于结构与取舍，不要粘贴代码。',
  }
}

/** 统一入口：字节 + 文件名 → 结果（内部判定类型）。 */
export function extractText(bytes: Uint8Array, filename: string, options: { maxChars: number }): IngestExtract {
  const kind = detectKind(filename)
  if (kind === 'unsupported') {
    return { ok: false, kind, text: '', chars: 0, truncated: false, note: unsupportedReason(filename) }
  }
  if (kind === 'text') return wrap(kind, extractPlainText(bytes, filename, options))
  if (kind === 'code') return codeFileExtract(filename, decodeTextBytes(bytes), options)
  return extractDocument(bytes, kind, options)
}

// ---------------------------------------------------------------------------
// 磁盘 I/O 注入点
// ---------------------------------------------------------------------------

/** 一个待摄取的文件（绝对路径 + 工作区相对路径 + 判定类型）。 */
export interface IngestFile {
  readonly absolute: string
  /** 字节数；无法取得时（测试注入的 IO）缺省为 -1。 */
  readonly size: number
  readonly rel: string
  /** 判定出的摄取类型（`code` 只做结构摘要，不返回源码正文）。 */
  readonly kind: IngestKind
}

/** 清单文件超过该字节数就不纳入技术栈指纹（只如实列出跳过）。 */
export const MAX_MANIFEST_BYTES = 200 * 1024

/** 摄取所需的 I/O：真实实现走 node:fs + ctx.fs，测试可注入内存实现。 */
export interface IngestIO {
  /** 指定路径是文件还是目录（不存在返回 undefined）。 */
  kind(target: string): Promise<'file' | 'dir' | undefined>
  /** 目录下的直接子项（不存在/无权限抛错）。 */
  list(target: string): Promise<readonly { name: string; isDirectory: boolean }[]>
  /** 读文件字节。 */
  read(target: string): Promise<Uint8Array>
}

/** 真实磁盘 I/O（二进制读取是文档化的例外：ctx.fs 只有 readText）。 */
export const diskIO: IngestIO = {
  async kind(target) {
    try {
      const info = await stat(target)
      return info.isDirectory() ? 'dir' : 'file'
    } catch {
      return undefined
    }
  },
  async list(target) {
    const entries = await readdir(target, { withFileTypes: true })
    const out: Array<{ name: string; isDirectory: boolean }> = []
    for (const entry of entries as Array<{ name: string; isDirectory(): boolean }>) {
      out.push({ name: entry.name, isDirectory: entry.isDirectory() })
    }
    return out
  },
  async read(target) {
    return new Uint8Array(await readFile(target))
  },
}

// ---------------------------------------------------------------------------
// 目录遍历
// ---------------------------------------------------------------------------

/** 一次摄取最多处理的文件数（防止把整个磁盘拖进来）。 */
export const MAX_FILES = 200
/** 递归深度上限。 */
export const MAX_DEPTH = 6

/** 后缀过滤：`docx,pdf,md` → 匹配集合（空 = 不过滤）。 */
export function parseGlobFilter(glob: string | undefined): Set<string> {
  const out = new Set<string>()
  if (glob === undefined) return out
  for (const part of glob.split(/[,，\s]+/)) {
    const cleaned = part.trim().toLowerCase().replace(/^\*?\.?/, '')
    if (cleaned !== '') out.add(`.${cleaned}`)
  }
  return out
}

function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf(nodePath.sep) + 1)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot).toLowerCase()
}

/** 是否跳过该目录（名称命中 SKIP_DIRS 尾段或整体相对路径）。 */
export function shouldSkipDir(name: string, rel: string): boolean {
  const normalizedRel = rel.replace(/\\/g, '/')
  for (const skip of SKIP_DIRS) {
    if (skip.includes('/')) {
      if (normalizedRel === skip || normalizedRel.endsWith(`/${skip}`)) return true
    } else if (name === skip) {
      return true
    }
  }
  return false
}

/** 递归枚举待摄取文件（目录）或单个文件。 */
export async function collectFiles(io: IngestIO, target: string, filter: Set<string>): Promise<IngestFile[]> {
  const kind = await io.kind(target)
  if (kind === undefined) throw new Error(`路径不存在：${target}`)
  if (kind === 'file') {
    return [{ absolute: target, size: await fileSize(io, target), rel: nodePath.basename(target), kind: detectKind(target) }]
  }
  const out: IngestFile[] = []
  const root = target
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || out.length >= MAX_FILES) return
    let entries: readonly { name: string; isDirectory: boolean }[]
    try {
      entries = await io.list(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (out.length >= MAX_FILES) return
      const absolute = nodePath.join(dir, entry.name)
      const rel = nodePath.relative(root, absolute)
      if (entry.isDirectory) {
        if (shouldSkipDir(entry.name, rel)) continue
        await walk(absolute, depth + 1)
        continue
      }
      const detected = detectKind(entry.name)
      const extension = extensionOf(entry.name)
      if (filter.size > 0 && !filter.has(extension)) continue
      // 无过滤器时也收旧版 Office 文件：它们会以 unsupported 失败并给出"另存为"提示。
      if (filter.size === 0 && detected === 'unsupported' && !LEGACY_EXTENSIONS.includes(extension)) continue
      out.push({ absolute, size: await fileSize(io, absolute), rel, kind: detected })
    }
  }
  await walk(root, 0)
  return out
}

/** 目录名 → 代码摘要文件名（`<目录名>-代码结构.md`）。 */
export function codeSummaryFileName(target: string): string {
  const base = nodePath.basename(target.replace(/[\\/]+$/, ''))
  const safe = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim()
  return `${safe === '' ? '项目' : safe}-代码结构.md`
}

/** 代码结构汇总（清单里单独一节 + 一份摘要文件）。 */
export interface CodeStructure {
  /** 参与摘要的源码文件数。 */
  readonly files: number
  /** 总行数 / 代码行数。 */
  readonly lines: number
  readonly codeLines: number
  /** 语言分布（语言 → 文件数/行数），按行数降序。 */
  readonly languages: ReadonlyArray<{ readonly language: CodeLanguage; readonly files: number; readonly lines: number }>
  /** 技术栈（由依赖清单推断）。 */
  readonly stack: ReadonlyArray<{ readonly name: string; readonly evidence: string }>
  /** 摘要文件在工作区内的相对路径。 */
  readonly summaryPath: string
  /** 未能摘要的文件（超大/读取失败），如实列出。 */
  readonly skipped: readonly string[]
}

/** 汇总一组单文件摘要。 */
export function buildCodeStructure(files: readonly CodeFileSummary[], manifests: Readonly<Record<string, string>>, summaryPath: string, skipped: readonly string[]): CodeStructure {
  const byLanguage = new Map<CodeLanguage, { files: number; lines: number }>()
  for (const file of files) {
    const bucket = byLanguage.get(file.language) ?? { files: 0, lines: 0 }
    bucket.files += 1
    bucket.lines += file.lines
    byLanguage.set(file.language, bucket)
  }
  return {
    files: files.length,
    lines: files.reduce((sum, file) => sum + file.lines, 0),
    codeLines: files.reduce((sum, file) => sum + file.codeLines, 0),
    languages: [...byLanguage.entries()]
      .map(([language, bucket]) => ({ language, files: bucket.files, lines: bucket.lines }))
      .sort((a, b) => b.lines - a.lines),
    stack: detectTechStack(manifests),
    summaryPath,
    skipped,
  }
}

/** 读取源码/清单文本（按统一解码，最多 1MB 防止超大文件吃内存）。 */
function readSmallText(bytes: Uint8Array): string {
  const slice = bytes.length > 1024 * 1024 ? bytes.subarray(0, 1024 * 1024) : bytes
  return decodeTextBytes(slice)
}

/** 文件字节数：通过 {@link statFileSize} 注入；注入式 IO（测试）返回 -1 表示未知。 */
async function fileSize(io: IngestIO, target: string): Promise<number> {
  const stat = statFileSize(io)
  if (stat === undefined) return -1
  try {
    return await stat(target)
  } catch {
    return -1
  }
}

/** 取字节数函数：只有真实磁盘 IO 才有（测试注入的 IO 不读磁盘）。 */
function statFileSize(io: IngestIO): ((target: string) => Promise<number>) | undefined {
  return io === diskIO ? async (target: string) => (await stat(target)).size : undefined
}

// ---------------------------------------------------------------------------
// 工作区落盘
// ---------------------------------------------------------------------------

/** 摘要目录（相对论文工作区根）。 */
export const MATERIAL_DIR = '00-管理/材料'
/** 清单文件（相对论文工作区根）。 */
export const MANIFEST_REL = '00-管理/材料清单.md'

/** 文件名 → 安全的摘要文件名（去扩展名，替换非法字符）。 */
export function summaryFileName(rel: string): string {
  const base = nodePath.basename(rel)
  const withoutExtension = base.replace(/\.[^.]*$/, '')
  const safe = withoutExtension.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim()
  return `${safe === '' ? '材料' : safe}.md`
}

/**
 * 生成单个文件的摘要 Markdown。
 * 含：原文件名、类型、字节数、字符数、是否截断/低置信、正文。
 */
export function buildSummary(rel: string, size: number, result: IngestExtract): string {
  return [
    `# 摄取摘要：${rel}`,
    '',
    `- 原文件：${rel}`,
    `- 类型：${result.kind}`,
    `- 字节数：${size}`,
    `- 字符数：${result.chars}`,
    `- 状态：${result.ok ? '成功' : '失败'}`,
    `- 截断：${result.truncated ? '是（超出 maxChars）' : '否'}`,
    `- 低置信：${result.lowConfidence === true ? '是（文本量明显偏少，请核对）' : '否'}`,
    ...(result.title !== undefined ? [`- 文档标题：${result.title}`] : []),
    ...(result.note !== undefined ? [`- 说明：${result.note}`] : []),
    '',
    '## 正文',
    '',
    result.ok && result.text !== '' ? result.text : '（未能抽取文本）',
    '',
  ].join('\n')
}

/** 生成工作区清单文件内容。 */
export function buildManifest(
  files: readonly IngestFile[],
  results: readonly IngestExtract[],
  written: readonly string[],
  skipped: readonly string[],
  code: CodeStructure | undefined,
): string {
  const lines: string[] = [
    '# 材料清单',
    '',
    `- 生成时间：${new Date().toISOString()}`,
    `- 文件数：${files.length}`,
    `- 成功：${results.filter(r => r.ok).length}，失败：${results.filter(r => !r.ok).length}`,
    '',
    '## 文件',
    '',
  ]
  for (const [index, file] of files.entries()) {
    const result = results[index]
    if (result === undefined) continue
    const status = result.ok ? '成功' : '失败'
    lines.push(`- ${file.rel}（${result.kind}，${file.size} 字节，${result.chars} 字符，${status}${result.truncated ? '，已截断' : ''}${result.lowConfidence === true ? '，低置信' : ''}）`)
    if (result.note !== undefined) lines.push(`  - 说明：${result.note}`)
  }
  if (code !== undefined) {
    lines.push('', '## 代码结构', '')
    lines.push(`- 源码文件：${code.files} 个，共 ${code.lines} 行（代码行 ${code.codeLines}）`)
    if (code.languages.length > 0) {
      lines.push(`- 语言分布：${code.languages.map(item => `${item.language} ${item.files} 个/${item.lines} 行`).join('、')}`)
    }
    if (code.stack.length > 0) {
      lines.push(`- 技术栈（由依赖清单推断，须核对）：${code.stack.map(item => item.name).join('、')}`)
    }
    lines.push(`- 摘要文件：${code.summaryPath}`)
    if (code.skipped.length > 0) {
      lines.push(`- 未纳入摘要：${code.skipped.join('、')}`)
    }
    lines.push('- 代码结构是「系统实现」章与答辩素材的骨架：**不要把源码正文贴进论文**。')
  }
  if (written.length > 0) {
    lines.push('', '## 已写入摘要', '', bulletList(written, '- '))
  }
  if (skipped.length > 0) {
    lines.push('', '## 已跳过（摘要文件已存在或无法写入，绝不覆盖）', '', bulletList(skipped, '- '))
  }
  lines.push('')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// 工具实现
// ---------------------------------------------------------------------------

/** `thesis_ingest` 的参数。 */
export interface IngestArgs {
  /** 文件或目录的绝对路径（必填）。 */
  path: string
  /** 可选后缀过滤，如 `docx,pdf,md`。 */
  glob?: string
  /** 是否把摘要落到论文工作区，默认 true。 */
  write?: boolean
}

/** 摄取结果（供测试与渲染共用）。 */
export interface IngestOutcome {
  readonly root: string | undefined
  readonly files: readonly IngestFile[]
  readonly results: readonly IngestExtract[]
  readonly written: readonly string[]
  readonly skipped: readonly string[]
  readonly failed: readonly { readonly rel: string; readonly reason: string }[]
  readonly truncatedCount: number
  readonly lowConfidence: readonly string[]
  /** 代码结构汇总（没有源码文件时为 undefined）。 */
  readonly code: CodeStructure | undefined
  readonly note: string | undefined
}

/** 执行摄取（I/O 注入；工具与测试共用）。 */
export async function runIngest(
  fs: FileSystem,
  io: IngestIO,
  args: IngestArgs,
  cwd: string | undefined,
  options: IngestOptions,
  signal?: AbortSignal,
): Promise<IngestOutcome> {
  const target = args.path
  if (target === undefined || target.trim() === '') {
    throw new Error('path 必填：文件或目录的绝对路径。')
  }
  if (!nodePath.isAbsolute(target)) {
    throw new Error(`path 必须是绝对路径，收到的是相对路径：${target}`)
  }
  const filter = parseGlobFilter(args.glob)
  const files = await collectFiles(io, target, filter)
  if (files.length === 0) {
    throw new Error(`在 ${target} 下没有找到可摄取的文档${args.glob !== undefined ? `（后缀过滤：${args.glob}）` : ''}。`)
  }

  const root = await findThesisRoot(fs, cwd, signal)
  const write = args.write !== false
  const results: IngestExtract[] = []
  const written: string[] = []
  const skipped: string[] = []
  const failed: Array<{ rel: string; reason: string }> = []
  const lowConfidence: string[] = []
  let truncatedCount = 0

  const canWrite = write && root !== null

  // 代码结构汇总（源码只做结构摘要，不落源码正文）
  const codeSummaries: CodeFileSummary[] = []
  const manifests: Record<string, string> = {}
  const codeSkipped: string[] = []
  const summaryPath = `${MATERIAL_DIR}/${codeSummaryFileName(target)}`
  const bytesCache = new Map<string, Uint8Array>()

  const readBytes = async (file: IngestFile): Promise<Uint8Array> => {
    const cached = bytesCache.get(file.absolute)
    if (cached !== undefined) return cached
    const bytes = await io.read(file.absolute)
    bytesCache.set(file.absolute, bytes)
    return bytes
  }

  for (const file of files) {
    if (file.size >= 0 && file.size > options.maxBytes) {
      const result: IngestExtract = {
        ok: false,
        kind: file.kind,
        text: '',
        chars: 0,
        truncated: false,
        note: `文件 ${file.size} 字节超过单文件上限 ${options.maxBytes} 字节：请拆分或先压缩后提供。`,
      }
      results.push(result)
      failed.push({ rel: file.rel, reason: result.note ?? '文件过大' })
      if (file.kind === 'code') codeSkipped.push(`${file.rel}（超过单文件上限）`)
      continue
    }
    let bytes: Uint8Array | undefined
    let result: IngestExtract
    try {
      bytes = await readBytes(file)
      result = extractText(bytes, file.rel, { maxChars: options.maxChars })
    } catch (error) {
      result = {
        ok: false,
        kind: file.kind,
        text: '',
        chars: 0,
        truncated: false,
        note: `读取失败：${error instanceof Error ? error.message : String(error)}`,
      }
    }
    results.push(result)
    if (!result.ok) failed.push({ rel: file.rel, reason: result.note ?? '抽取失败' })
    if (result.truncated) truncatedCount += 1
    if (result.lowConfidence === true) lowConfidence.push(file.rel)

    // 代码结构：源码进来做摘要；依赖清单进来做技术栈指纹（超大清单如实跳过）
    if (file.kind === 'code' && bytes !== undefined) {
      codeSummaries.push(summarizeSource(file.rel, readSmallText(bytes)))
    } else if (isManifestFile(file.rel) && bytes !== undefined) {
      if (bytes.length > MAX_MANIFEST_BYTES) {
        codeSkipped.push(`${file.rel}（清单 ${bytes.length} 字节，超过 ${MAX_MANIFEST_BYTES} 字节上限）`)
      } else {
        manifests[file.rel] = readSmallText(bytes)
      }
    }

    if (!canWrite) continue
    const fileSummaryRel = `${MATERIAL_DIR}/${summaryFileName(file.rel)}`
    const absolute = nodePath.join(root!, fileSummaryRel)
    try {
      const existing = await fs.stat(await fs.resolve(absolute, { signal }), signal)
      if (existing !== undefined) {
        skipped.push(`${fileSummaryRel}（已存在，跳过）`)
        continue
      }
    } catch {
      // stat 失败/未实现：按"不存在"处理，下面写入时仍可能失败。
    }
    try {
      await fs.writeText(await fs.resolve(absolute, { signal }), buildSummary(file.rel, file.size, result), undefined, signal)
      written.push(fileSummaryRel)
    } catch (error) {
      skipped.push(`${fileSummaryRel}（写入失败：${error instanceof Error ? error.message : String(error)}）`)
    }
  }

  const code = codeSummaries.length > 0 || Object.keys(manifests).length > 0
    ? buildCodeStructure(codeSummaries, manifests, summaryPath, codeSkipped)
    : undefined

  if (canWrite && code !== undefined) {
    const absolute = nodePath.join(root!, code.summaryPath)
    let exists = false
    try {
      exists = (await fs.stat(await fs.resolve(absolute, { signal }), signal)) !== undefined
    } catch {
      exists = false
    }
    if (exists) {
      skipped.push(`${code.summaryPath}（已存在，跳过）`)
    } else {
      try {
        const markdown = renderProjectSummary({ root: target, files: codeSummaries, manifests, skipped: codeSkipped })
        await fs.writeText(await fs.resolve(absolute, { signal }), markdown, undefined, signal)
        written.push(code.summaryPath)
      } catch (error) {
        skipped.push(`${code.summaryPath}（写入失败：${error instanceof Error ? error.message : String(error)}）`)
      }
    }
  }

  if (canWrite) {
    const manifest = buildManifest(files, results, written, skipped, code)
    try {
      await fs.writeText(await fs.resolve(nodePath.join(root!, MANIFEST_REL), { signal }), manifest, undefined, signal)
    } catch (error) {
      skipped.push(`${MANIFEST_REL}（写入失败：${error instanceof Error ? error.message : String(error)}）`)
    }
  }

  const note = root === null
    ? '未找到论文工作区（向上查找 00-管理/进度台账.md 失败）：本次只返回结果，未落盘。请先在论文仓库目录内操作，或先运行 thesis_init。'
    : write
      ? undefined
      : 'write=false：本次只返回结果，未落盘。'

  return {
    root: root ?? undefined,
    files,
    results,
    written,
    skipped,
    failed,
    truncatedCount,
    lowConfidence,
    code,
    note,
  }
}

/** 按优先级给出"该带进追问的关键材料"建议。 */
export function suggestNextSteps(files: readonly IngestFile[], results: readonly IngestExtract[]): string[] {
  const kinds = new Set(results.map(result => result.kind))
  const names = files.map(file => file.rel.toLowerCase())
  const tips: string[] = []
  if (!names.some(name => /模板|template|格式要求|格式规范/.test(name)) && !kinds.has('docx')) {
    tips.push('还没读到学校论文模板/格式要求（.docx）：追问前务必补上，否则格式要求只能靠猜。')
  }
  if (!kinds.has('xlsx') && !names.some(name => /(csv|数据|实验|结果)/.test(name))) {
    tips.push('还没读到实验数据（.xlsx/.csv）：结论与图表都需要它，请一并提供。')
  }
  if (!names.some(name => /(bib|ris|refs|参考文献|文献)/.test(name))) {
    tips.push('还没读到参考文献（.bib/.ris/.txt）：引用真实性核查需要它。')
  }
  if (!results.some(result => result.lowConfidence === true)) {
    tips.push('建议把材料清单（00-管理/材料清单.md）带去 intake：追问会按"已读到/还缺什么"逐项确认。')
  }
  tips.push('优先带进追问的顺序：学校模板与评分标准 → 实验数据 → 代码结构/README → 参考文献 → 往届论文。')
  return tips
}

/** 渲染工具返回值（有界字符串，遵守 maxChars）。 */
export function renderOutcome(outcome: IngestOutcome, maxChars: number): string {
  const lines: string[] = []
  lines.push(`材料摄取：读取 ${outcome.files.length} 个文件（成功 ${outcome.results.filter(r => r.ok).length}，失败 ${outcome.failed.length}）`)
  lines.push(outcome.root !== undefined ? `论文工作区：${outcome.root}` : '论文工作区：未找到')
  lines.push('')
  lines.push('## 文件清单')
  for (const [index, file] of outcome.files.entries()) {
    const result = outcome.results[index]
    if (result === undefined) continue
    const status = result.ok ? '成功' : `失败（${result.note ?? '未知原因'}）`
    lines.push(`- ${file.rel} ｜ ${result.kind} ｜ ${file.size} 字节 ｜ ${result.chars} 字符${result.truncated ? '（已截断）' : ''}${result.lowConfidence === true ? '（低置信）' : ''} ｜ ${status}`)
  }
  if (outcome.code !== undefined) {
    lines.push('', '## 代码结构')
    lines.push(`- 源码文件：${outcome.code.files} 个，共 ${outcome.code.lines} 行（代码行 ${outcome.code.codeLines}）`)
    if (outcome.code.languages.length > 0) {
      lines.push(`- 语言分布：${outcome.code.languages.map(item => `${item.language} ${item.files} 个/${item.lines} 行`).join('、')}`)
    }
    if (outcome.code.stack.length > 0) {
      lines.push(`- 技术栈（由依赖清单推断，须核对）：${outcome.code.stack.map(item => item.name).join('、')}`)
    }
    lines.push(`- 摘要文件：${outcome.code.summaryPath}`)
    if (outcome.code.skipped.length > 0) lines.push(`- 未纳入摘要：${outcome.code.skipped.join('、')}`)
    lines.push('- 代码结构是「系统实现」章与答辩素材的骨架：**不要把源码正文贴进论文**。')
  }
  if (outcome.written.length > 0) {
    lines.push('', `## 已写入（${outcome.written.length} 个摘要 + 材料清单）`, bulletList(outcome.written))
  }
  if (outcome.skipped.length > 0) {
    lines.push('', '## 已跳过', bulletList(outcome.skipped))
  }
  if (outcome.note !== undefined) lines.push('', `注意：${outcome.note}`)
  lines.push('', '## 下一步建议')
  lines.push(bulletList(suggestNextSteps(outcome.files, outcome.results)))
  const text = lines.join('\n')
  if (text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars - 20))}\n…（清单过长已截断）`
}

// ---------------------------------------------------------------------------
// 工具注册
// ---------------------------------------------------------------------------

/** `thesis_ingest` 工具的装配参数。 */
export interface RegisterIngestOptions {
  /** 摄取配置（`maxBytes`/`maxChars`，来自 `src/config.ts`）。 */
  readonly ingest: IngestOptions
}

/** 注册 `thesis_ingest`（同步注册，走仓库统一的 `definePaperTool`；斜杠命令见 `commands.ts`）。 */
export function registerIngest(ctx: Context, options: RegisterIngestOptions): void {
  ctx.tools.register(definePaperTool({
    name: 'thesis_ingest',
    description:
      '把学生手上的材料读成纯文本或结构摘要：.docx（论文模板/要求/往届论文）、.xlsx/.csv（实验数据）、.pptx（答辩/课程 PPT）、' +
      '.pdf（要求文件/往届论文，尽力而为）、.md/.txt/.bib/.ris/.html，以及**源码结构摘要**（.ts/.py/.java/.go… 只给文件/行数/声明/技术栈，不给源码正文）。' +
      'path 给文件或目录绝对路径（目录会递归，深度上限 6，自动跳过 node_modules/.git/产出等）；glob 可按后缀过滤（如 docx,pdf）；' +
      'write=true 时把清单写进论文工作区的 00-管理/材料清单.md、每个文件的摘要写进 00-管理/材料/<文件名>.md、代码结构写进 00-管理/材料/<目录名>-代码结构.md' +
      '（已存在的摘要绝不覆盖）。失败的 PDF（扫描版/加密/无 ToUnicode 的 CID 字体）会如实说明原因，不会编造内容。',
    parameters: {
      path: { type: 'string', required: true, description: '文件或目录的绝对路径（目录会递归枚举）' },
      glob: { type: 'string', description: '可选后缀过滤，逗号分隔，如 docx,pdf,md,ts（缺省按支持的格式自动筛选）' },
      write: { type: 'boolean', description: '是否把清单与摘要写入论文工作区，默认 true；findThesisRoot 失败时只返回结果' },
    },
    output: OUTPUT,
    async execute(rawArgs, exec) {
      const args = rawArgs as IngestArgs
      const outcome = await runIngest(ctx.fs, diskIO, args, sessionCwd(exec), options.ingest, exec.signal)
      return renderOutcome(outcome, options.ingest.maxChars)
    },
  }))
  ctx.commands.register(ingestCommand(ctx.fs, options.ingest))
}
