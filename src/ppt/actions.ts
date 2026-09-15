/**
 * `thesis_slides` 的四个动作实现（outline / convert / check / guide）。
 *
 * 与 `src/paper/tools/*.ts` 同一分层思路：**业务逻辑在这里，靠 `defineTool` 的
 * 胶水在 `index.ts`**。本文件只依赖 Node 内置与 `FileSystem` 的**类型**（宿主在
 * 运行期提供真实实现），因此在没有安装宿主包的离线环境里也能被单元测试直接导入。
 *
 * 落盘约定（全部相对论文仓库根）：
 * - `07-答辩/PPT.md`（outline；默认不覆盖，force 时先备份为 `PPT-<时间戳>.md`）
 * - `07-答辩/PPT.pptx`（convert 成功时，由外部转换器写出）
 * - `07-答辩/PPT转换说明.md`（convert 无论成败都写：探测结果 + 命令 + 退出码 + 输出摘要）
 *
 * @module dsh-thesis/ppt
 */

import * as nodePath from 'node:path'
import { existsSync } from 'node:fs'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { PptOptions } from '../config.ts'
import { findThesisRoot } from '../paper/lib/project.ts'
import { buildSlidePlan, loadOutlineInputs, audienceProfile, type Audience, type OutlineInputs, type SlidePlan } from './outline.ts'
import { renderMarp } from './marp.ts'
import { checkDeck, renderCheckReport, verifyAnchors, type CheckResult, type SlideIssue } from './check.ts'
import { conversionGuide, convert, detectEngines, renderConversionNotes, type ConversionResult, type EngineDetection } from './convert.ts'

/** `thesis_slides` 的参数。 */
export interface PptArgs {
  readonly action: 'outline' | 'convert' | 'check' | 'guide'
  /** 目标页数（默认 11，会夹到骨架允许区间）。 */
  readonly pages?: number
  /** 听众档位：undergrad（默认）| master。 */
  readonly audience?: Audience
  /** outline：已存在 PPT.md 时是否覆盖（默认 false，覆盖前自动备份）。 */
  readonly force?: boolean
}

/** 可注入的依赖（测试用替身；生产用默认实现）。 */
export interface PptDeps {
  /** 引擎探测替身。 */
  readonly detect?: () => EngineDetection
  /** 转换替身（测试用它模拟成功/失败）。 */
  readonly convert?: (slidesPath: string, outPath: string, options: { engine: PptOptions['engine']; timeoutMs: number }) => ConversionResult
  /** 二进制落盘钩子（默认不做事：真实转换器已把 pptx 写在目标路径上）。 */
  readonly writeBinary?: (absPath: string, data: Uint8Array) => Promise<void>
  /** 时间源（测试固定备份文件名）。 */
  readonly now?: () => Date
}

/** PPT 工具在论文工作区里的所有落盘位置。 */
export const PPT_RELS = {
  /** 幻灯 Markdown（唯一真源）。 */
  slides: '07-答辩/PPT.md',
  /** 外部转换器产出的 pptx。 */
  pptx: '07-答辩/PPT.pptx',
  /** 转换说明（探测结果 + 确切命令，任何情况都写）。 */
  notes: '07-答辩/PPT转换说明.md',
  /** 素材（输入，由 thesis_defense 生成）。 */
  materials: '07-答辩/答辩素材.md',
} as const

/** 目标页数的合法区间（放置非法入参）。 */
const PAGES_MIN = 8
const PAGES_MAX = 20

/** 动作返回：有界文本 + 结构化关键事实（测试与上层复用）。 */
export interface PptActionResult {
  readonly text: string
  readonly plan?: SlidePlan
  readonly detection?: EngineDetection
  readonly conversion?: ConversionResult
  readonly error?: string
}

function clampPages(pages: number | undefined): number {
  const value = pages === undefined || !Number.isFinite(pages) ? 11 : Math.round(pages)
  return Math.min(PAGES_MAX, Math.max(PAGES_MIN, value))
}

function normalizeAudience(audience: Audience | undefined): Audience {
  return audience === 'master' ? 'master' : 'undergrad'
}

/** 时间戳（本地时间，文件名安全：20260912-184800）。 */
export function timestamp(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

async function readOptional(fs: FileSystem, absPath: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    return await fs.readText(await fs.resolve(absPath, { signal }), signal)
  } catch {
    return undefined
  }
}

async function writeText(fs: FileSystem, absPath: string, content: string, signal?: AbortSignal): Promise<void> {
  await fs.writeText(await fs.resolve(absPath, { signal }), content, undefined, signal)
}

/** 把绝对路径转成工作区内的 POSIX 相对路径（写进说明文档，跨平台可读）。 */
function relativeForDisplay(root: string, absPath: string): string {
  return nodePath.relative(root, absPath).split(nodePath.sep).join('/') || absPath
}

/** 由已装载的素材构建幻灯计划（工具与测试共用）。 */
export function planFromInputs(inputs: OutlineInputs, audience: Audience, pages: number): SlidePlan {
  const { ledgerTitle, ...rest } = inputs
  return buildSlidePlan({ title: ledgerTitle, audience, targetPages: pages, ...rest })
}

async function resolveDeck(fs: FileSystem, root: string, signal?: AbortSignal): Promise<string> {
  const markdown = await readOptional(fs, nodePath.join(root, PPT_RELS.slides), signal)
  if (markdown === undefined) {
    throw new Error(`${PPT_RELS.slides} 尚未生成。请先运行 thesis_slides action=outline。`)
  }
  return markdown
}

/** 定位论文仓库根；找不到即抛错（所有动作都要求在工作区内）。 */
export async function requireRoot(fs: FileSystem, cwd: string | undefined, signal?: AbortSignal): Promise<string> {
  const root = await findThesisRoot(fs, cwd, signal)
  if (root === null) throw new Error('未找到论文工作区。请先在论文仓库目录内操作（需要 00-管理/进度台账.md）。')
  return root
}

// ---------------------------------------------------------------------------
// outline
// ---------------------------------------------------------------------------

/** outline 的文本摘要（有界）。 */
export function outlineSummary(plan: SlidePlan, slidesRel: string, notesRel: string, backupRel?: string): string {
  const lines = [
    `幻灯 Markdown 已生成：${slidesRel}`,
    `- 实际页数：${plan.pages} 页（听众：${audienceProfile(plan.audience).label}）`,
    `- 预计时长：${plan.estimate.minMinutes}-${plan.estimate.maxMinutes} 分钟（每页 ${plan.estimate.secondsPerSlideMin}-${plan.estimate.secondsPerSlideMax} 秒）`,
    `- 素材来源：${plan.source === 'defense-materials' ? PPT_RELS.materials : '06-论文/章节/*.md（回退）'}`,
  ]
  if (plan.note !== undefined) lines.push(`- 提示：${plan.note}`)
  if (plan.pageAdjustment !== undefined) lines.push(`- 页数调整：${plan.pageAdjustment}`)
  for (const warning of plan.warnings) lines.push(`- 注意：${warning}`)
  if (backupRel !== undefined) lines.push(`- 旧文件已备份为：${backupRel}`)
  lines.push(`- 转换说明：${notesRel}`)
  lines.push('')
  lines.push('下一步：')
  lines.push('- 复核页数/要点/讲稿后运行 thesis_slides action=convert 生成 PPT.pptx')
  lines.push('- 或运行 thesis_slides action=guide 获取可复制执行的转换命令（本机未装 marp/pandoc 时用）')
  return lines.join('\n')
}

/** `action=outline`：生成/刷新 `07-答辩/PPT.md`。 */
export async function runOutline(
  fs: FileSystem,
  root: string,
  args: PptArgs,
  options: { ppt: PptOptions },
  signal?: AbortSignal,
  deps: PptDeps = {},
): Promise<PptActionResult> {
  const now = deps.now ?? (() => new Date())
  const audience = normalizeAudience(args.audience)
  const targetPages = clampPages(args.pages)
  const slidesAbs = nodePath.join(root, PPT_RELS.slides)

  const inputs = await loadOutlineInputs(fs, root, signal)
  const plan = planFromInputs(inputs, audience, targetPages)
  const markdown = renderMarp(plan, { theme: options.ppt.theme, footer: 'dsh-thesis · 答辩幻灯', header: plan.title })

  const existing = await readOptional(fs, slidesAbs, signal)
  if (existing !== undefined && existing.trim() !== '' && args.force !== true) {
    return {
      plan,
      text: [
        `${PPT_RELS.slides} 已存在，未覆盖（保护你手工改过的内容）。`,
        `- 现有文件：${PPT_RELS.slides}`,
        `- 本次将生成 ${plan.pages} 页（若确认覆盖，请带 force=true；旧文件会先备份为 07-答辩/PPT-<时间戳>.md）`,
        '',
        '建议：先 thesis_slides action=check 看现有文件的问题清单，或复制一份再重新生成。',
      ].join('\n'),
    }
  }

  let backupRel: string | undefined
  if (existing !== undefined && existing.trim() !== '') {
    backupRel = `07-答辩/PPT-${timestamp(now())}.md`
    await writeText(fs, nodePath.join(root, backupRel), existing, signal)
  }
  await writeText(fs, slidesAbs, markdown, signal)
  return { plan, text: outlineSummary(plan, PPT_RELS.slides, PPT_RELS.notes, backupRel) }
}

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

/** check 的完整结果（含锚点落盘校验）。 */
export interface DeckCheck {
  readonly result: CheckResult
  readonly anchorIssues: readonly SlideIssue[]
  readonly text: string
}

/** `action=check`：对已有 `07-答辩/PPT.md` 做确定性质量检查。 */
export async function runCheckAction(
  fs: FileSystem,
  root: string,
  args: PptArgs,
  signal?: AbortSignal,
): Promise<DeckCheck> {
  const markdown = await resolveDeck(fs, root, signal)
  const result = checkDeck(markdown, {
    audience: normalizeAudience(args.audience),
    fs,
    root,
    targetPages: args.pages !== undefined ? clampPages(args.pages) : undefined,
  })
  const anchorIssues = await verifyAnchors(markdown, fs, root)
  const merged: CheckResult = {
    ...result,
    issues: [...result.issues, ...anchorIssues],
    warnings: result.warnings + anchorIssues.length,
  }
  return { result: merged, anchorIssues, text: renderCheckReport(merged, PPT_RELS.slides) }
}

// ---------------------------------------------------------------------------
// convert
// ---------------------------------------------------------------------------

/** convert 的文本摘要（有界）。 */
export function convertSummary(
  slidesRel: string,
  pptxRel: string,
  notesRel: string,
  detection: EngineDetection,
  engine: PptOptions['engine'],
  result: ConversionResult | undefined,
  error: string | undefined,
): string {
  const lines: string[] = []
  if (result !== undefined && result.ok) {
    lines.push(`转换成功：${pptxRel}（引擎：${result.engine}）`)
  } else {
    lines.push(`未产出 pptx：${error ?? '未知原因'}`)
  }
  lines.push(`- 幻灯 Markdown：${slidesRel}`)
  lines.push(`- 目标文件：${pptxRel}`)
  lines.push(`- 配置引擎：${engine}`)
  lines.push(`- 探测：marp=${detection.marp ? '可用' : '无'}；npx marp-cli=${detection.marpNpx ? '可用' : '无'}；pandoc=${detection.pandoc ? '可用' : '无'}`)
  if (result !== undefined) {
    for (const record of result.commands) {
      lines.push(`- 命令：${[record.command, ...record.args].join(' ')} → 退出码 ${record.status ?? 'null'}，耗时 ${record.elapsedMs} ms`)
    }
  }
  lines.push(`- 转换说明（含命令与输出摘要）：${notesRel}`)
  if (result === undefined || !result.ok) {
    lines.push('')
    lines.push('下一步（可直接复制执行）：')
    lines.push(`- npx --yes @marp-team/marp-cli "${slidesRel}" --pptx --output "${pptxRel}" --allow-local-files`)
    lines.push('- 或运行 thesis_slides action=guide 查看完整指引（PowerShell/Unix/手工兜底/离线方案）')
  }
  return lines.join('\n')
}

/** `action=convert`：执行外部转换；失败时**先写说明再抛错**（绝不假装成功）。 */
export async function runConvertAction(
  fs: FileSystem,
  root: string,
  options: { ppt: PptOptions },
  signal?: AbortSignal,
  deps: PptDeps = {},
): Promise<PptActionResult> {
  const now = deps.now ?? (() => new Date())
  const detect = deps.detect ?? (() => detectEngines())
  const runConvert = deps.convert ?? ((slidesPath, outPath, opts) =>
    convert(slidesPath, outPath, { engine: opts.engine, timeoutMs: opts.timeoutMs, exists: path => existsSync(path) }))
  const writePptx = deps.writeBinary ?? (async () => {})

  const slidesAbs = nodePath.join(root, PPT_RELS.slides)
  const pptxAbs = nodePath.join(root, PPT_RELS.pptx)
  const notesAbs = nodePath.join(root, PPT_RELS.notes)
  await resolveDeck(fs, root, signal)

  const detection = detect()
  let result: ConversionResult | undefined
  let failure: string | undefined
  try {
    result = runConvert(slidesAbs, pptxAbs, { engine: options.ppt.engine, timeoutMs: options.ppt.timeoutMs })
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
  }
  if (result !== undefined && result.ok && failure === undefined) {
    // 真实转换器已经把 pptx 写在目标路径上；这里只调用落盘钩子（测试替身用），
    // 生产环境用它保证"产出即落盘"这一契约可替换、可测。
    await writePptx(pptxAbs, new Uint8Array(0))
  }

  const notes = renderConversionNotes({
    slidesPath: relativeForDisplay(root, slidesAbs),
    outPath: relativeForDisplay(root, pptxAbs),
    detection,
    engine: options.ppt.engine,
    ...(result !== undefined ? { result } : {}),
    ...(failure !== undefined ? { error: failure } : {}),
    theme: options.ppt.theme,
    now: now(),
  })
  await writeText(fs, notesAbs, notes, signal)

  const text = convertSummary(PPT_RELS.slides, PPT_RELS.pptx, PPT_RELS.notes, detection, options.ppt.engine, result, failure)
  if (failure !== undefined) {
    return {
      text: `${text}\n\n（转换说明已写入 ${PPT_RELS.notes}）`,
      detection,
      error: failure,
    }
  }
  return { text, detection, ...(result !== undefined ? { conversion: result } : {}) }
}

// ---------------------------------------------------------------------------
// guide
// ---------------------------------------------------------------------------

/** `action=guide`：只输出可复制执行的转换指引，不写盘、不执行。 */
export function runGuideAction(deps: PptDeps = {}): PptActionResult {
  const detect = deps.detect ?? (() => detectEngines())
  const detection = detect()
  return { text: conversionGuide(PPT_RELS.slides, PPT_RELS.pptx, detection), detection }
}

// ---------------------------------------------------------------------------
// 动作分发
// ---------------------------------------------------------------------------

/**
 * 按 action 分发。`convert` 失败时抛出的错误里**带上已经写好的说明**，
 * 让模型看到的是一次真实失败 + 下一步命令，而不是沉默。
 */
export async function runPptAction(
  fs: FileSystem,
  cwd: string | undefined,
  args: PptArgs,
  options: { ppt: PptOptions },
  signal?: AbortSignal,
  deps: PptDeps = {},
): Promise<PptActionResult> {
  if (args.action === 'guide') return runGuideAction(deps)
  const root = await requireRoot(fs, cwd, signal)
  if (args.action === 'outline') return runOutline(fs, root, args, options, signal, deps)
  if (args.action === 'check') {
    const checked = await runCheckAction(fs, root, args, signal)
    return { text: checked.text }
  }
  if (args.action === 'convert') {
    const outcome = await runConvertAction(fs, root, options, signal, deps)
    if (outcome.error !== undefined) throw new Error(outcome.text)
    return outcome
  }
  throw new Error(`未知 action：${String(args.action)}。可用：outline | convert | check | guide。`)
}
