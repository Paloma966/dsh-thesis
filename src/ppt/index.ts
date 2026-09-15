/**
 * 答辩幻灯装配层：注册 `thesis_slides` 工具（outline / convert / check / guide）。
 *
 * 分层与论文流水线一致：
 * - 业务逻辑在 `ppt/actions.ts`、`ppt/outline.ts`、`ppt/marp.ts`、`ppt/check.ts`、
 *   `ppt/convert.ts`（零 cordis 依赖，可独立单测，测试不需要安装宿主包）；
 * - 本文件只做 `defineTool` 胶水。
 *
 * 产品决策：**不自研 pptx 生成器**。Markdown 是唯一真源，pptx 由 marp-cli /
 * pandoc 产出；两者都没有时给出可直接复制执行的命令与手工兜底，绝不假装成功。
 *
 * @module dsh-thesis/ppt
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PptOptions } from '../config.ts'
import { definePaperTool, sessionCwd, textOutput, writeBinary } from '../shared/index.ts'
import { runPptAction, type PptArgs, type PptDeps } from './actions.ts'

export { buildSlidePlan, parseDefenseMaterials, parseChapterFallback, truncateBullet, truncateTitle, audienceProfile, titleFromLedger, loadOutlineInputs, summarizePlan, composeSlides, MAX_BULLET_CHARS, MAX_TITLE_CHARS, MAX_BULLETS_PER_SLIDE, MIN_BULLETS_PER_SLIDE, SECONDS_PER_SLIDE_MIN, SECONDS_PER_SLIDE_MAX } from './outline.ts'
export type { Audience, PlannedSlide, PlanBullet, SlidePlan, SlideKind, DefenseMaterials, OutlineInputs } from './outline.ts'
export { renderMarp, parseMarp, parseFrontmatter, findUnsafeMarkdown, sanitizeTheme, sanitizeYamlScalar, MARP_THEMES } from './marp.ts'
export type { MarpOptions, ParsedDeck, ParsedSlide } from './marp.ts'
export { detectEngines, convert, conversionGuide, renderConversionNotes, guideCommands } from './convert.ts'
export type { ConversionResult, EngineChoice, EngineDetection, EngineName, CommandRecord, SpawnFn } from './convert.ts'
export { checkDeck, renderCheckReport, verifyAnchors } from './check.ts'
export type { CheckResult, SlideIssue } from './check.ts'
export { runPptAction, runOutline, runCheckAction, runConvertAction, runGuideAction, planFromInputs, PPT_RELS } from './actions.ts'
export type { PptArgs, PptDeps, PptActionResult, DeckCheck } from './actions.ts'
export { handlePptCommand, parsePptCommandInput } from './commands.ts'

/** `thesis_slides` 的工具描述（中文，面向模型与用户）。 */
export const PPT_TOOL_DESCRIPTION =
  '答辩幻灯（Markdown 为准，pptx 交给外部工具）：outline 依据 07-答辩/答辩素材.md 生成 Marp 兼容的 07-答辩/PPT.md（10-12 页骨架、每页 3-6 条要点、讲稿注释、证据锚点；默认不覆盖已有文件，force 时先备份）；' +
  'convert 探测 marp / npx marp-cli / pandoc 并执行转换产出 07-答辩/PPT.pptx（失败抛错并给出确切命令，绝不假装成功）；' +
  'check 做确定性质量检查（页数/要点数/字数/讲稿/锚点/待补充标记/预计时长 8-12 分钟）并逐条定位；guide 只输出转换指引。' +
  '无论成败都写 07-答辩/PPT转换说明.md（探测结果 + 命令 + 退出码 + 输出摘要）。'

/**
 * 注册 `thesis_slides` 工具与 `/thesis-defense` 命令。
 *
 * 二进制例外（与 `thesis_build` 一致，文档化）：pptx 由外部命令直接写在目标路径，
 * `ctx.fs` 无二进制写入能力，故落盘钩子用 node:fs（{@link writeBinary}）；
 * 文本产物（PPT.md、PPT转换说明.md）全部走 `ctx.fs`。
 */
export function registerPpt(ctx: Context, options: { ppt: PptOptions }, deps: PptDeps = {}): void {
  const fullDeps: PptDeps = { writeBinary, ...deps }
  ctx.tools.register(definePaperTool({
    name: 'thesis_slides',
    description: PPT_TOOL_DESCRIPTION,
    parameters: {
      action: { type: 'string', required: true, description: 'outline（生成/刷新幻灯 Markdown）| convert（执行转换）| check（质量检查）| guide（只输出转换指引）' },
      pages: { type: 'number', description: '目标页数，默认 11；本科骨架允许 10-12 页，超出会自动夹取并在结果里说明' },
      audience: { type: 'string', description: '听众档位：undergrad（默认，40-60 秒/页）| master（45-70 秒/页，骨架上限更高）' },
      force: { type: 'boolean', description: 'outline 时覆盖已存在的 07-答辩/PPT.md，默认 false（覆盖前把旧文件另存为 07-答辩/PPT-<时间戳>.md）' },
    },
    output: textOutput(),
    async execute(rawArgs, exec): Promise<string> {
      const args = { ...((rawArgs ?? {}) as PptArgs) }
      const outcome = await runPptAction(ctx.fs, sessionCwd(exec), args, options, exec.signal, fullDeps)
      return outcome.text
    },
  }))
}

export const PPT_REL_PATHS = {
  slides: '07-答辩/PPT.md',
  pptx: '07-答辩/PPT.pptx',
  notes: '07-答辩/PPT转换说明.md',
} as const

export type { PptOptions }
