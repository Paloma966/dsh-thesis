/**
 * dsh-thesis 降重模块的门面与工具装配。
 *
 * 三层结构：
 * - `normalize.ts`  文本归一化 + 段落切分（带原文偏移映射）
 * - `similarity.ts` shingle 指纹、倒排索引、包含率/杰卡德/最长公共子串
 * - `rewrite.ts` / `report.ts` 改写处方与报告渲染
 *
 * 本文件只做两件事：把正文段落与参考语料装进扫描器；注册 `thesis_originality` 工具
 * 并把报告落到 `08-合规/降重报告.md`（verify 另写 `08-合规/降重报告-复测.md`）。
 *
 * **边界**：不做知网/维普等收费系统的接入（无授权，也不应接入）。
 * 本地相似度只是字符串重合度估算，权威口径是学校检测结果，可回填到报告里。
 *
 * @module dsh-thesis/dedup
 */

import * as nodePath from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { bulletList, definePaperTool, sessionCwd, textOutput } from '../shared/index.ts'
import { CHAPTER_META, isWrittenChapter } from '../paper/lib/layout.ts'
import { findThesisRoot } from '../paper/lib/project.ts'
import type { SimilarityOptions } from '../config.ts'
import { dedupCommand } from './commands.ts'
import { segmentsFromText, type Segment } from './normalize.ts'
import { scan, type ScanOptions, type ScanResult } from './similarity.ts'
import {
  buildReport,
  parseBaseline,
  renderReport,
  renderVerifyReport,
  verifyDelta,
  weightedRateOf,
  type DedupReport,
  type DetectedResult,
  type ReportOptions,
} from './report.ts'

export const REPORT_REL = '08-合规/降重报告.md'
export const VERIFY_REPORT_REL = '08-合规/降重报告-复测.md'
export const CHAPTERS_REL = '06-论文/章节'

/** 缺省参考语料目录（相对论文工作区根）。 */
export const DEFAULT_CORPUS_DIRS: readonly string[] = [
  '02-文献/笔记',
  '05-实验测试/结果',
  '00-管理/材料',
]

/** 参与比对的文件扩展名。 */
const CORPUS_EXTENSIONS = ['.md', '.txt', '.tex', '.csv']

/** 扫描到的参考文件（`file` 是相对论文工作区根的 POSIX 路径）。 */
export interface CorpusFile {
  readonly file: string
  readonly label: string
  readonly text: string
}

/** thesis_originality 的参数。 */
export interface DedupArgs {
  /** scan | verify | report。 */
  readonly action: string
  /** 参考语料路径（文件或目录），可多个；缺省用 DEFAULT_CORPUS_DIRS。 */
  readonly corpus?: string
  /** 只处理某一章（章节文件名，可带 .md）。 */
  readonly chapter?: string
  /** verify 用：上一次 scan 落盘的报告路径。 */
  readonly baseline?: string
  /** report 用：用户自行送检得到的重复率（0..1 或百分数）。 */
  readonly detected_rate?: number
  /** report 用：检测系统名称。 */
  readonly detected_system?: string
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/')
}

/** `thesis_originality` 的注册参数：相似度配置来自 `src/config.ts` 的 `SimilarityOptions`。 */
export interface DedupOptions {
  readonly similarity: SimilarityOptions
}

function scanOptionsFor(similarity: SimilarityOptions): ScanOptions {
  return { shingle: similarity.shingle, threshold: similarity.threshold }
}

/**
 * 读取目录下（不递归子目录）参与比对的文本文件；目录不存在返回空数组。
 */
async function readDirFiles(
  fs: FileSystem,
  root: string,
  relDir: string,
  signal?: AbortSignal,
): Promise<CorpusFile[]> {
  const entries = await listDirSafe(fs, nodePath.join(root, relDir), signal)
  const files: CorpusFile[] = []
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const entry of sorted) {
    if (entry.name.startsWith('.')) continue
    const rel = `${relDir}/${entry.name}`
    if (entry.isDirectory) {
      const nested = await readDirFiles(fs, root, rel, signal)
      for (const file of nested) files.push(file)
      continue
    }
    if (!CORPUS_EXTENSIONS.some(ext => entry.name.toLowerCase().endsWith(ext))) continue
    const text = await readTextSafe(fs, nodePath.join(root, rel), signal)
    if (text === null) continue
    files.push({ file: rel, label: rel, text })
  }
  return files
}

async function listDirSafe(fs: FileSystem, abs: string, signal?: AbortSignal): Promise<{ name: string; isDirectory: boolean }[]> {
  try {
    return await fs.listDir(await fs.resolve(abs, { signal }), signal)
  } catch {
    return []
  }
}

async function readTextSafe(fs: FileSystem, abs: string, signal?: AbortSignal): Promise<string | null> {
  try {
    return await fs.readText(await fs.resolve(abs, { signal }), signal)
  } catch {
    return null
  }
}

/** 收集参考语料：显式路径优先，否则用缺省目录 + 各章正文（互查）。 */
export async function collectCorpus(
  fs: FileSystem,
  root: string,
  corpusArg: string | undefined,
  excludeFiles: readonly string[],
  wholeChapters: boolean,
  signal?: AbortSignal,
): Promise<CorpusFile[]> {
  const exclude = new Set(excludeFiles.map(toPosix))
  const found: CorpusFile[] = []
  const push = (file: CorpusFile): void => {
    if (exclude.has(toPosix(file.file))) return
    if (found.some(existing => existing.file === file.file)) return
    found.push(file)
  }

  if (corpusArg !== undefined && corpusArg.trim() !== '') {
    for (const raw of corpusArg.split(/[;,]/)) {
      const entry = raw.trim()
      if (entry === '') continue
      const abs = nodePath.isAbsolute(entry) ? entry : nodePath.join(root, entry)
      const text = await readTextSafe(fs, abs, signal)
      if (text !== null) {
        const rel = toPosix(nodePath.isAbsolute(entry) ? nodePath.basename(entry) : entry)
        push({ file: rel, label: rel, text })
        continue
      }
      const relDir = toPosix(nodePath.isAbsolute(entry) ? nodePath.basename(entry) : entry)
      const files = await readDirFiles(fs, root, relDir, signal)
      for (const file of files) push(file)
    }
    return found
  }

  for (const dir of DEFAULT_CORPUS_DIRS) {
    const files = await readDirFiles(fs, root, dir, signal)
    for (const file of files) push(file)
  }
  // 正文互查：其他章整章作为语料（本段所在章由 excludeFiles/自比屏蔽排除）。
  if (wholeChapters) {
    for (const meta of CHAPTER_META) {
      const rel = `${CHAPTERS_REL}/${meta.file}.md`
      if (exclude.has(rel)) continue
      const text = await readTextSafe(fs, nodePath.join(root, rel), signal)
      if (text === null) continue
      push({ file: rel, label: `${meta.file}（正文互查）`, text })
    }
  }
  return found
}

/** 读取正文段落（按章切分；chapter 为空则全部已撰写章）。 */
export async function loadChapterSegments(
  fs: FileSystem,
  root: string,
  chapter: string | undefined,
  minChars: number,
  signal?: AbortSignal,
): Promise<{ segments: Segment[]; missing: string[]; corpusCandidates: CorpusFile[] }> {
  const wanted = chapter === undefined ? undefined : (chapter.endsWith('.md') ? chapter.slice(0, -3) : chapter)
  const segments: Segment[] = []
  const missing: string[] = []
  const corpusCandidates: CorpusFile[] = []
  for (const [index, meta] of CHAPTER_META.entries()) {
    if (wanted !== undefined && meta.file !== wanted) continue
    const rel = `${CHAPTERS_REL}/${meta.file}.md`
    const text = await readTextSafe(fs, nodePath.join(root, rel), signal)
    if (text === null || !isWrittenChapter(text, index + 1, meta)) {
      missing.push(meta.file)
      continue
    }
    corpusCandidates.push({ file: rel, label: `${meta.file}（正文互查）`, text })
    const split = segmentsFromText(text, { file: rel, chapter: meta.file, minChars })
    for (const segment of split.segments) segments.push(segment)
  }
  return { segments, missing, corpusCandidates }
}

// ---------------------------------------------------------------------------
// 各 action
// ---------------------------------------------------------------------------

interface ScanOutcome {
  readonly scanResult: ScanResult
  readonly report: DedupReport
  readonly markdown: string
  readonly options: ReportOptions
  readonly missing: string[]
  readonly corpusLabels: readonly string[]
}

async function runScan(fs: FileSystem, root: string, args: DedupArgs, similarity: SimilarityOptions, now: Date, detected: DetectedResult | undefined, signal?: AbortSignal): Promise<ScanOutcome> {
  const loaded = await loadChapterSegments(fs, root, args.chapter, similarity.minChars, signal)
  const explicitCorpus = args.corpus !== undefined && args.corpus.trim() !== ''
  // 本次已作为正文扫描的章不再进语料：与"自己所在的那一章"比较是自比，不是重复。
  const corpusFiles = await collectCorpus(fs, root, args.corpus, loaded.corpusCandidates.map(file => file.file), !explicitCorpus, signal)
  const scanResult = scan({
    segments: loaded.segments,
    corpus: corpusFiles.map(file => ({ id: file.file, label: file.label, text: file.text })),
    options: scanOptionsFor(similarity),
  })
  const options: ReportOptions = {
    threshold: similarity.threshold,
    shingle: similarity.shingle,
    minChars: similarity.minChars,
    now,
    corpusLabels: corpusFiles.length === 0 ? ['（无语料，仅统计段落）'] : corpusFiles.map(file => file.file),
    ...(detected !== undefined ? { detected } : {}),
  }
  const report = buildReport(scanResult, options)
  return {
    scanResult,
    report,
    markdown: renderReport(report, options),
    options,
    missing: loaded.missing,
    corpusLabels: options.corpusLabels ?? [],
  }
}

function summaryLines(outcome: ScanOutcome, target: string, extra: string[]): string[] {
  const { scanResult, report } = outcome
  const top = report.risks.slice(0, 5)
  const lines: string[] = []
  lines.push(`文件数：${new Set(outcome.scanResult.items.map(item => item.segment.file)).size} 个正文文件（正文段落 ${scanResult.paragraphCount} 段，语料 ${scanResult.corpusCount} 份）`)
  lines.push(`分级：high ${scanResult.high} 段 | medium ${scanResult.medium} 段 | low ${scanResult.low} 段（有命中 ${scanResult.matchedCount} 段）`)
  lines.push(`全文加权重复率估算：${(weightedRateOf(scanResult) * 100).toFixed(1)}%（口径见报告第 0 节；非学校检测结果）`)
  lines.push('')
  lines.push('Top 5 高风险段落：')
  if (top.length === 0) {
    lines.push('- 无中/高风险段落')
  } else {
    lines.push(bulletList(top.map((risk, index) =>
      `${index + 1}. ${risk.chapter} 第 ${risk.lineStart}-${risk.lineEnd} 行：${(risk.score * 100).toFixed(1)}% ← ${risk.source}`)))
  }
  lines.push('')
  lines.push('下一步建议：')
  lines.push(bulletList([
    '先改高风险段落：按处方换结构（拆句/换语序/主被动），必须保留数字、单位、引用标记与代码标识符',
    '命中来源是文献笔记时，改为直接引用 + [n] 标注，不要改写成自己的话',
    '改写完成后执行 thesis_originality action=verify（baseline 传本次报告路径）复测降幅',
    '送检后把真实重复率回填：thesis_originality action=report detected_rate=<百分比>',
  ], '- '))
  if (extra.length > 0) {
    lines.push('')
    for (const line of extra) lines.push(line)
  }
  lines.push('')
  lines.push(`报告已写入：${target}（每次覆盖，含时间戳与算法参数）`)
  return lines
}

async function writeReport(fs: FileSystem, root: string, rel: string, content: string, signal?: AbortSignal): Promise<void> {
  await fs.writeText(await fs.resolve(nodePath.join(root, rel), { signal }), content, undefined, signal)
}

/** 执行 thesis_originality 的全部动作；返回有界文本摘要。 */
export async function runDedup(fs: FileSystem, cwd: string | undefined, args: DedupArgs, similarity: SimilarityOptions, signal?: AbortSignal): Promise<string> {
  // action 必填：缺省/空串**不静默当成 scan**——那会在用户只想看报告时意外跑一次全量扫描并覆盖报告。
  const action = (args.action ?? '').trim()
  if (action === '') {
    throw new Error('action 必填：scan（首次扫描并落盘）| verify（对 baseline 复测降幅）| report（生成/回填检测结果）。')
  }
  if (!['scan', 'verify', 'report'].includes(action)) {
    throw new Error(`未知 action：${action}（只支持 scan | verify | report）。`)
  }
  const root = await findThesisRoot(fs, cwd, signal)
  if (root === null) throw new Error('未找到论文工作区。请先在论文仓库目录内操作。')
  const now = new Date()
  const detected = detectedFrom(args)
  const missingNote = (missing: readonly string[]): string[] =>
    missing.length === 0 ? [] : [`⚠ 未撰写/缺失章节未计入：${missing.join('、')}`]

  if (action === 'verify') {
    const current = await runScan(fs, root, args, similarity, now, detected, signal)
    const baselineRel = args.baseline !== undefined && args.baseline.trim() !== '' ? args.baseline.trim() : REPORT_REL
    const baselineText = await readTextSafe(fs, nodePath.isAbsolute(baselineRel) ? baselineRel : nodePath.join(root, baselineRel), signal)
    if (baselineText === null) {
      throw new Error(`未找到 baseline 报告：${baselineRel}。请先执行 thesis_originality action=scan 生成 ${REPORT_REL}。`)
    }
    const baseline = parseBaseline(baselineText)
    if (baseline === null) {
      throw new Error(`baseline 报告无法解析（${baselineRel}）。baseline 必须是 thesis_originality scan 生成的降重报告。`)
    }
    const currentSnapshot = {
      paragraphCount: current.scanResult.paragraphCount,
      matchedCount: current.scanResult.matchedCount,
      high: current.scanResult.high,
      medium: current.scanResult.medium,
      weightedRate: weightedRateOf(current.scanResult),
    }
    const delta = verifyDelta(baseline, currentSnapshot)
    await writeReport(fs, root, REPORT_REL, current.markdown, signal)
    await writeReport(fs, root, VERIFY_REPORT_REL, renderVerifyReport(delta, current.options, current.report), signal)
    const head = [
      `复测完成：加权重复率估算 ${(delta.baseline.weightedRate * 100).toFixed(1)}% → ${(delta.current.weightedRate * 100).toFixed(1)}%`,
      `降幅：${(delta.rateDrop * 100).toFixed(1)} 个百分点（相对 ${(delta.rateDropRatio * 100).toFixed(1)}%）`,
      `高风险 ${delta.baseline.high} → ${delta.current.high} 段；中风险 ${delta.baseline.medium} → ${delta.current.medium} 段`,
      `结论：${delta.verdict}`,
      '',
    ]
    return [
      ...head,
      ...summaryLines(current, `${VERIFY_REPORT_REL}（并覆盖 ${REPORT_REL}）`, missingNote(current.missing)),
    ].join('\n')
  }

  if (action !== 'scan' && action !== 'report') {
    throw new Error(`未知 action：${action}（只支持 scan | verify | report）`)
  }
  const outcome = await runScan(fs, root, args, similarity, now, detected, signal)
  await writeReport(fs, root, REPORT_REL, outcome.markdown, signal)
  const head: string[] = []
  if (outcome.scanResult.paragraphCount === 0) {
    head.push('⚠ 没有可比对的正文段落：章节未撰写或全部段落短于 minChars。')
    head.push('')
  }
  if (outcome.scanResult.corpusCount === 0) {
    head.push('⚠ 参考语料为空：请把可能的来源文本放进 02-文献/笔记、05-实验测试/结果 或 00-管理/材料，或用 corpus 参数显式指定。')
    head.push('')
  }
  return [
    ...head,
    ...summaryLines(outcome, REPORT_REL, missingNote(outcome.missing)),
  ].join('\n')
}

function detectedFrom(args: DedupArgs): DetectedResult | undefined {
  const rate = args.detected_rate
  if (rate === undefined || !Number.isFinite(rate)) return undefined
  const detected: DetectedResult = { rate: rate > 1 ? rate / 100 : rate }
  const withSystem: DetectedResult = args.detected_system === undefined ? detected : { ...detected, system: args.detected_system }
  return withSystem
}

/**
 * 注册 `thesis_originality`：本地相似度扫描 / 复测 / 报告回填。
 *
 * 参数：`action`（scan | verify | report）、`corpus`（参考语料路径，文件或目录）、
 * `chapter`（只处理某一章）、`baseline`（verify 的上次报告路径）、
 * `detected_rate`（report 回填的学校检测重复率）、`detected_system`。
 * 落盘：`08-合规/降重报告.md`；verify 另写 `08-合规/降重报告-复测.md`。
 */
export function registerDedup(ctx: Context, options: { similarity: SimilarityOptions }): void {
  ctx.tools.register(definePaperTool({
    name: 'thesis_originality',
    description:
      '原创性自查（本地、确定性、零依赖、不联网）：把正文段落与参考语料做 shingle 指纹比对，'
      + '给出每段的包含率得分、命中来源、命中片段（行号与原文）、结构化改写处方与全文加权重复率估算，'
      + '报告写入 08-合规/降重报告.md。'
      + 'action=scan 首次扫描；verify 用 baseline 报告复测降幅（另写 08-合规/降重报告-复测.md）；'
      + 'report 把用户自行送检得到的重复率回填进报告。'
      + '缺省语料为 02-文献/笔记、05-实验测试/结果、00-管理/材料 + 正文各章互查；corpus 可显式指定文件或目录。'
      + '**本工具不接入知网/维普等收费查重系统**：本地结果是字符串重合度估算，权威口径是学校检测结果。',
    parameters: {
      action: { type: 'string', required: true, description: 'scan（扫描并落盘）| verify（对 baseline 复测降幅）| report（生成/回填学校检测结果）' },
      corpus: { type: 'string', description: '参考语料路径（文件或目录，可多个用逗号分隔）；缺省用 02-文献/笔记、05-实验测试/结果、00-管理/材料 + 正文各章互查' },
      chapter: { type: 'string', description: '只处理某一章，如 01-绪论（可带 .md）' },
      baseline: { type: 'string', description: 'verify 用：上一次 scan 落盘的报告路径，缺省 08-合规/降重报告.md' },
      detected_rate: { type: 'number', description: 'report 用：用户自行送检得到的重复率（0.12 或 12 均可，>1 视为百分数）' },
      detected_system: { type: 'string', description: 'report 用：检测系统名称，如「知网 PMLC」' },
    },
    output: textOutput(),
    async execute(rawArgs, exec) {
      return await runDedup(ctx.fs, sessionCwd(exec), rawArgs as DedupArgs, options.similarity, exec.signal)
    },
  }))

  // `/thesis-originality [scan|verify|report] [语料路径] [--chapter 01-绪论]`：与工具同一执行层，
  // 命令只是给人用的快捷入口（命令名只允许 [a-z][a-z0-9_-]*）。
  if (ctx.commands !== undefined) {
    ctx.commands.register(dedupCommand(ctx.fs, options.similarity))
  }
}

export { segmentsFromText, scan, buildReport, renderReport, weightedRateOf }
export type { Segment, ScanResult, DedupReport, SimilarityOptions }
