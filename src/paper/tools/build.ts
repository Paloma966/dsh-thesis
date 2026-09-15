/**
 * thesis_build：产出论文 docx（+ 可选 pdf）。
 *
 * 引擎选择：
 * - pandoc 存在时优先（--reference-doc 使用学校模板）；
 * - 无 pandoc 时使用内置零依赖转换器（lib/docx.ts），并在构建说明中
 *   显式标注"内置过渡引擎，非学校模板排版"。
 *
 * 二进制例外（文档化）：ctx.fs 无二进制写入能力，docx/pdf 字节由本工具
 * 通过 node:fs 直接写入论文仓库 06-论文/产出/ 目录。文本工作全部走 ctx.fs。
 */

import * as nodePath from 'node:path'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { describeFailure, spawnCommand } from '../../shared/spawn.ts'
import { buildDocx } from '../lib/docx.ts'
import { CHAPTER_META, isWrittenChapter } from '../lib/layout.ts'
import { parseLedger } from '../lib/ledger.ts'
import { findThesisRoot } from '../lib/project.ts'

export interface BuildArgs {
  format?: 'docx' | 'pdf' | 'both'
  engine?: 'auto' | 'pandoc' | 'internal'
}

export type WriteBinary = (absPath: string, data: Uint8Array) => Promise<void>

const OUT_DIR = '06-论文/产出'
const TEMPLATE_DIR = '06-论文/assets/学校模板'

async function readOptional(fs: FileSystem, absPath: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    return await fs.readText(await fs.resolve(absPath, { signal }), signal)
  } catch {
    return undefined
  }
}

async function listOptional(fs: FileSystem, absPath: string, signal?: AbortSignal): Promise<string[]> {
  try {
    const entries = await fs.listDir(await fs.resolve(absPath, { signal }), signal)
    return entries.map(e => e.name)
  } catch {
    return []
  }
}

function pandocAvailable(): boolean {
  return spawnCommand('pandoc', ['--version'], { timeoutMs: PROBE_TIMEOUT_MS }).ok
}

/** 引擎探测的超时（毫秒）：探测不该拖住工具调用。 */
const PROBE_TIMEOUT_MS = 10_000
/** 单次 pandoc 转换的超时（毫秒）：大型论文 + 模板可能慢，但必须有上限。 */
const CONVERT_TIMEOUT_MS = 120_000

export interface BuildOutcome {
  readonly docxPath: string
  readonly pdfPath?: string
  readonly engine: 'pandoc' | 'internal'
  readonly template: string | undefined
  readonly chapters: readonly string[]
  readonly missing: readonly string[]
}

export async function runBuild(
  fs: FileSystem,
  args: BuildArgs,
  cwd: string | undefined,
  signal: AbortSignal | undefined,
  writeBinary: WriteBinary,
): Promise<BuildOutcome> {
  const root = await findThesisRoot(fs, cwd, signal)
  if (root === null) throw new Error('未找到论文工作区。请先在论文仓库目录内操作。')

  const format = args.format ?? 'docx'
  if (format === 'pdf' && (args.engine ?? 'auto') === 'internal') {
    throw new Error('内置引擎只能产出 docx。PDF 需要 pandoc（并安装 LaTeX 引擎）。')
  }

  // 章节收集（按模板顺序；只收录"已撰写"章节）
  const chapterParts: string[] = []
  const included: string[] = []
  const missing: string[] = []
  for (const [index, meta] of CHAPTER_META.entries()) {
    const text = await readOptional(fs, nodePath.join(root, '06-论文/章节', `${meta.file}.md`), signal)
    if (text === undefined || !isWrittenChapter(text, index + 1, meta)) {
      missing.push(meta.file)
      continue
    }
    included.push(meta.file)
    chapterParts.push(text)
  }
  if (included.length === 0) throw new Error('没有任何已撰写章节（06-论文/章节/*.md 均为空）。')

  // 标题：台账 state.title，缺省通用
  let title = '本科毕业论文（设计）'
  const ledgerText = await readOptional(fs, nodePath.join(root, '00-管理/进度台账.md'), signal)
  if (ledgerText !== undefined) {
    const parsed = parseLedger(ledgerText)
    if (parsed.found && parsed.state.title !== undefined && parsed.state.title !== '') title = parsed.state.title
  }
  const markdown = chapterParts.join('\n\n')

  // 模板探测
  const templateFiles = await listOptional(fs, nodePath.join(root, TEMPLATE_DIR), signal)
  const template = templateFiles.find(f => /\.(docx?|dotx?)$/i.test(f))

  // 引擎选择
  const requested = args.engine ?? 'auto'
  const hasPandoc = pandocAvailable()
  let engine: 'pandoc' | 'internal'
  if (requested === 'pandoc') {
    if (!hasPandoc) throw new Error('请求 pandoc 引擎但本机未安装 pandoc。请安装 pandoc 或改用 internal 引擎。')
    engine = 'pandoc'
  } else if (requested === 'internal') {
    engine = 'internal'
  } else {
    engine = hasPandoc ? 'pandoc' : 'internal'
  }

  // docx 字节
  const docxPath = nodePath.join(root, OUT_DIR, '论文.docx')
  let docxBytes: Uint8Array
  if (engine === 'internal') {
    docxBytes = buildDocx({ title, markdown })
  } else {
    // pandoc：合并内容写临时文件后转换
    const tmpMd = nodePath.join(tmpdir(), `dsh-thesis-build-${process.pid}-${Date.now()}.md`)
    await writeFile(tmpMd, `${title}\n\n${'='.repeat(Math.max(4, title.length))}\n\n${markdown}`, 'utf8')
    try {
      const argv = ['-f', 'markdown', '-t', 'docx', '-o', docxPath]
      if (template !== undefined) argv.push('--reference-doc', nodePath.join(root, TEMPLATE_DIR, template))
      argv.push(tmpMd)
      const result = spawnCommand('pandoc', argv, { timeoutMs: CONVERT_TIMEOUT_MS })
      if (!result.ok) throw new Error(`pandoc 转换失败：${describeFailure('pandoc', result)}`)
      docxBytes = new Uint8Array(await readFile(docxPath))
    } finally {
      await rm(tmpMd, { force: true }).catch(() => {})
    }
  }
  await writeBinary(docxPath, docxBytes)

  // pdf（仅 pandoc）
  let pdfPath: string | undefined
  if (format === 'pdf' || format === 'both') {
    if (engine !== 'pandoc') throw new Error('PDF 需要 pandoc。')
    const out = nodePath.join(root, OUT_DIR, '论文.pdf')
    const tmpMd = nodePath.join(tmpdir(), `dsh-thesis-build-${process.pid}-${Date.now()}.md`)
    await writeFile(tmpMd, `${title}\n\n${'='.repeat(Math.max(4, title.length))}\n\n${markdown}`, 'utf8')
    try {
      const result = spawnCommand('pandoc', ['-f', 'markdown', '-t', 'pdf', '-o', out, tmpMd], { timeoutMs: CONVERT_TIMEOUT_MS })
      if (!result.ok) throw new Error(`PDF 转换失败（通常缺 LaTeX 引擎）：${describeFailure('pandoc', result)}`)
      pdfPath = out
    } finally {
      await rm(tmpMd, { force: true }).catch(() => {})
    }
  }

  // 构建说明（文本，走 ctx.fs）
  const note = [
    '# 构建说明',
    '',
    `- 时间：${new Date().toISOString()}`,
    `- 引擎：${engine === 'pandoc' ? 'pandoc' : '内置过渡引擎（非学校模板排版）'}`,
    `- 学校模板：${template ?? '未发现（请将学校模板放入 06-论文/assets/学校模板/ 后重建）'}`,
    `- 收录章节：${included.join('、') || '无'}`,
    `- 未收录章节（空或缺失）：${missing.join('、') || '无'}`,
    `- 产物：论文.docx${pdfPath !== undefined ? '、论文.pdf' : ''}`,
    '',
  ].join('\n')
  await fs.writeText(await fs.resolve(nodePath.join(root, OUT_DIR, '构建说明.md'), { signal }), note, undefined, signal)

  return { docxPath, ...(pdfPath !== undefined ? { pdfPath } : {}), engine, template, chapters: included, missing }
}

export function buildSummary(outcome: BuildOutcome): string {
  const lines = [
    `构建完成：${outcome.docxPath}`,
    ...(outcome.pdfPath !== undefined ? [`PDF：${outcome.pdfPath}`] : []),
    `- 引擎：${outcome.engine === 'pandoc' ? 'pandoc' : '内置过渡引擎（非学校模板排版，提交前请获取学校模板后用 pandoc 重建）'}`,
    `- 学校模板：${outcome.template ?? '未发现'}`,
    `- 收录章节：${outcome.chapters.join('、')}`,
    ...(outcome.missing.length > 0 ? [`- 未收录（空/缺失）：${outcome.missing.join('、')}`] : []),
    '',
    '打开 论文.docx 检查排版；构建细节见 06-论文/产出/构建说明.md。',
  ]
  return lines.join('\n')
}
