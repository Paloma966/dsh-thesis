/**
 * 论文工作区的工具与命令装配：台账、关卡、文献、评审、检查、构建、答辩素材。
 *
 * 纯业务逻辑在 `paper/tools/*.ts` 与 `paper/lib/*.ts`（零 cordis 依赖、可独立
 * 测试）；本文件只做 `defineTool` / 命令注册的胶水。
 *
 * @module dsh-thesis/paper
 */

import type { Context } from '@deepseek-ai/cordis'
import { definePaperTool, sessionCwd, textOutput, writeBinary } from '../shared/index.ts'
import { buildCommand, checkCommand, decideCommand, litCommand, statusCommand } from './commands.ts'
import { initSummary, runInit, type InitArgs } from './tools/init.ts'
import { runProgress, type ProgressArgs } from './tools/progress.ts'
import { runDecision, type DecisionArgs } from './tools/decision.ts'
import { runLitNote, runLitSave, runLitSearch, type LitNoteArgs, type LitSaveArgs, type LitSearchArgs } from './tools/lit.ts'
import { runReview, type ReviewArgs } from './tools/review.ts'
import { buildSummary, runBuild, type BuildArgs } from './tools/build.ts'
import { runCheck } from './tools/check.ts'
import { runAiSelfcheckTool } from './tools/aicheck.ts'
import { runDefensePrep } from './tools/defense.ts'
import { LIT_SOURCES } from './lib/lit-api.ts'

/** 论文流水线装配所需的宿主侧输入。 */
export interface PaperOptions {
  /** 随包发布的技能目录绝对路径（`thesis_init` 复制到论文仓库 `.dsh/skills/`）。 */
  readonly skillsDir: string
}

/**
 * 注册 11 个论文工具 + 5 个斜杠命令。
 *
 * 命令名只允许 `[a-z][a-z0-9_-]*`，故统一 `thesis-` 前缀。
 */
export function registerPaper(ctx: Context, options: PaperOptions): void {
  ctx.tools.register(definePaperTool({
    name: 'thesis_init',
    description:
      '在指定绝对路径创建论文工作区：目录结构、进度台账、决定日志、时间线、七章论文模板、文献库骨架，并把 dsh-thesis 技能包写入 .dsh/skills/（项目级技能，随 git 版本化）。可选 git 初始化并首次提交。目标目录须为空或不存在；绝不覆盖已有文件。',
    parameters: {
      root: { type: 'string', required: true, description: '工作区根目录的绝对路径（空目录或不存在）' },
      title: { type: 'string', description: '论文/课题标题，缺省为"本科毕业设计"（之后可改）' },
      git: { type: 'boolean', description: '是否 git 初始化并首次提交，默认 true' },
      force: { type: 'boolean', description: '目标目录非空时仍尝试写入，默认 false（安全第一）' },
    },
    output: textOutput(),
    async execute(rawArgs, exec) {
      const outcome = await runInit(ctx.fs, rawArgs as InitArgs, options.skillsDir, exec.signal)
      return initSummary(outcome)
    },
  }))

  ctx.tools.register(definePaperTool({
    name: 'thesis_progress',
    description:
      '读写论文进度台账（00-管理/进度台账.md）并强制执行人工关卡闸门：' +
      'report 查看当前阶段/关卡/任务状态；update 推进任务状态（todo/doing/done，受阶段入口关卡约束）；' +
      'gate 通过或重置人工关卡 G1（选题拍板）/G2（逐章验收，需 chapter）/G3（开题审阅）/G4（提交前自查），' +
      '通过关卡前其关联任务必须先完成。',
    parameters: {
      action: { type: 'string', required: true, description: 'report | update | gate' },
      task_id: { type: 'string', description: 'update 时必填：任务 ID（如 T1.1）' },
      status: { type: 'string', description: 'update 时必填：todo | doing | done' },
      note: { type: 'string', description: '可选备注（update 与 gate 均可用）' },
      gate: { type: 'string', description: 'gate 时必填：G1 | G2 | G3 | G4' },
      pass: { type: 'boolean', description: 'gate 时必填：true 通过，false 重置' },
      chapter: { type: 'string', description: 'gate=G2 时必填：章节文件名，如 01-绪论' },
    },
    output: textOutput(),
    async execute(rawArgs, exec) {
      return await runProgress(ctx.fs, rawArgs as ProgressArgs, sessionCwd(exec), exec.signal)
    },
  }))

  ctx.tools.register(definePaperTool({
    name: 'thesis_decide',
    description:
      '向决定日志（00-管理/决定日志.md）追加一条关键决定：内容、理由、备选方案。' +
      '用于选题、技术选型、方案变更等所有「答辩时会被问到为什么」的决策，全程留痕。',
    parameters: {
      content: { type: 'string', required: true, description: '决定的实际内容' },
      title: { type: 'string', description: '决定标题，缺省取 content 首行前 24 字' },
      reason: { type: 'string', description: '做这个决定的理由（可选，强烈建议填写）' },
      alternatives: { type: 'string', description: '考虑过的备选方案及弃用原因（可选，强烈建议填写）' },
    },
    output: textOutput(),
    async execute(rawArgs, exec) {
      return await runDecision(ctx.fs, rawArgs as DecisionArgs, sessionCwd(exec), exec.signal)
    },
  }))

  ctx.tools.register(definePaperTool({
    name: 'thesis_lit_search',
    description:
      '从真实学术数据库检索文献（Semantic Scholar→DBLP→arXiv→Crossref 失败降级；source 可指定单一来源）。' +
      '结果写入论文工作区的检索缓存与检索记录（审计留痕）。论文引用只能来自本工具的真实检索结果——这是零假文献红线。',
    parameters: {
      query: { type: 'string', required: true, description: '检索关键词（中英文均可，如 "attention is all you need"）' },
      year_from: { type: 'number', description: '年份下限，如 2020' },
      limit: { type: 'number', description: '返回条数上限，默认 10，最大 20' },
      source: { type: 'string', description: `指定单一来源：${LIT_SOURCES.join(' | ')}；缺省 auto（降级链）` },
    },
    output: textOutput(),
    async execute(rawArgs, exec) {
      return await runLitSearch(ctx.fs, rawArgs as LitSearchArgs, sessionCwd(exec), exec.signal, fetch)
    },
  }))

  ctx.tools.register(definePaperTool({
    name: 'thesis_lit_save',
    description:
      '把 thesis_lit_search 检索到的文献（按缓存 id）收录进 02-文献/refs.bib，并写检索审计记录。' +
      '只接受真实检索缓存中的 id；DOI 已在库中则自动跳过；bib key 冲突自动加后缀。',
    parameters: {
      ids: { type: 'array', items: { type: 'string' }, required: true, description: 'thesis_lit_search 返回的记录 id 列表' },
    },
    output: textOutput(),
    async execute(rawArgs, exec) {
      return await runLitSave(ctx.fs, rawArgs as LitSaveArgs, sessionCwd(exec), exec.signal)
    },
  }))

  ctx.tools.register(definePaperTool({
    name: 'thesis_lit_note',
    description:
      '为已检索/已收录的文献生成阅读笔记骨架（02-文献/笔记/<key>.md）：元数据、原始摘要、' +
      '"这篇解决什么问题/方法要点/实验结论/与我课题的关系/可用引用句"五节模板。已有笔记不覆盖（force 除外）。',
    parameters: {
      ref: { type: 'string', required: true, description: '缓存记录 id 或 refs.bib 条目 key' },
      force: { type: 'boolean', description: '笔记已存在时强制覆盖，默认 false' },
    },
    output: textOutput(),
    async execute(rawArgs, exec) {
      return await runLitNote(ctx.fs, rawArgs as LitNoteArgs, sessionCwd(exec), exec.signal)
    },
  }))

  ctx.tools.register(definePaperTool({
    name: 'thesis_review',
    description:
      '对论文单章做确定性评审（六项可机器验证的检查）：字数是否在目标区间、大纲小节是否齐全、' +
      '引用编号是否都能对应 refs.bib 条目、图/表编号章号与连续性、待补/TODO 等未完成标记、' +
      '章内 G2 验收清单勾选状态。语义质量（论证/逻辑）由 AI 依据 thesis-writing 技能另评；' +
      '全部通过后进入 G2 人工验收（用户阅读→修改→签字，再 thesis_progress gate G2 pass）。',
    parameters: {
      chapter: { type: 'string', required: true, description: '章节文件名，如 01-绪论（可带 .md）' },
    },
    output: textOutput(),
    async execute(rawArgs, exec) {
      return await runReview(ctx.fs, rawArgs as ReviewArgs, sessionCwd(exec), exec.signal)
    },
  }))

  ctx.tools.register(definePaperTool({
    name: 'thesis_check',
    description:
      '全文综合检查（五项）：引用双向一致（正文引用 ↔ refs.bib、编号连续、躺尸文献）、每章字数 vs 目标区间与全文合计、' +
      '图/表编号章号与连续性、术语缩写定义先于使用、学校模板文件探测。报告写入 08-合规/引用检查报告/ 与 08-合规/格式检查报告/。',
    parameters: {},
    output: textOutput(),
    async execute(_rawArgs, exec) {
      return await runCheck(ctx.fs, sessionCwd(exec), exec.signal)
    },
  }))

  ctx.tools.register(definePaperTool({
    name: 'thesis_build',
    description:
      '把已撰写章节（06-论文/章节/*.md）构建为论文.docx（可附 pdf）：优先 pandoc + 学校模板（06-论文/assets/学校模板/），' +
      '无 pandoc 时用内置过渡引擎并显式标注。构建说明写入 06-论文/产出/构建说明.md。',
    parameters: {
      format: { type: 'string', description: 'docx（默认）| pdf | both' },
      engine: { type: 'string', description: 'auto（默认，有 pandoc 用之）| pandoc | internal' },
    },
    output: textOutput(),
    async execute(rawArgs, exec) {
      const args = rawArgs as BuildArgs
      const outcome = await runBuild(ctx.fs, args, sessionCwd(exec), exec.signal, writeBinary)
      return buildSummary(outcome)
    },
  }))

  ctx.tools.register(definePaperTool({
    name: 'thesis_stylecheck',
    description:
      '对已撰写章节做写作风格自查（六条确定性启发式）：模板套话、空洞结论句、自我暴露（错误级）、翻译腔、' +
      '句式单一（连续同开头段落）、无锚点长段落。命中项附行号与改写建议；报告写入 08-合规/AI味自查报告.md。'
      + '这是自查不是检测结论，最终以学校检测结果为准。',
    parameters: {},
    output: textOutput(),
    async execute(_rawArgs, exec) {
      return await runAiSelfcheckTool(ctx.fs, sessionCwd(exec), exec.signal)
    },
  }))

  ctx.tools.register(definePaperTool({
    name: 'thesis_defense',
    description:
      '答辩准备：从工作区提取答辩素材（课题/各章概览/技术选型/关键决定/测试数据/git 工作量/文献数）写入 07-答辩/答辩素材.md，' +
      '并生成六类必问预答辩问题库骨架（实现细节/技术选型/需求背景/工作量/数据可信/不足展望，附证据锚点）写入 07-答辩/预答辩问题库.md。' +
      '具体问题由 AI 依据素材生成，模拟问答由用户完成（技能 thesis-defense）；「你的系统怎么实现的」这类问题用 defense_code_* 演练。',
    parameters: {},
    output: textOutput(),
    async execute(_rawArgs, exec) {
      return await runDefensePrep(ctx.fs, sessionCwd(exec), exec.signal)
    },
  }))

  ctx.commands.register(statusCommand(ctx.fs))
  ctx.commands.register(decideCommand(ctx.fs))
  ctx.commands.register(litCommand(ctx.fs))
  ctx.commands.register(checkCommand(ctx.fs))
  ctx.commands.register(buildCommand(ctx.fs))
}
