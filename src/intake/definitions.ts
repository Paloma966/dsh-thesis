/**
 * `thesis_intake` 的工具定义与参数类型。
 *
 * 单独成文件的理由：定义（参数表 + execute）必须是**纯数据**，不能把
 * `definePaperTool` / `ctx.tools.register` 这类宿主能力带进来——否则离线测试
 * 加载 `questions/state/spec` 时会连带 import 宿主包。装配入口在 `./index.ts` 的
 * {@link registerIntake}。
 *
 * @module dsh-thesis/intake
 */

import type { FileSystemLike } from './state.ts'

/** `thesis_intake` 的参数（`action` 之外的字段按 action 取用）。 */
export interface IntakeArgs {
  action: string
  /** 回答哪个问题（稳定 id，如 `school.template`）。 */
  question_id?: string
  /** 用户的答案原文。 */
  answer?: string
  /** 跳过理由（`action=skip` 必填）。 */
  reason?: string
  /** 本次会话已经问过几个问题（执行 `maxQuestions` 上限）。 */
  session_asked?: number
  /** 未知字段原样保留，便于回显与排错。 */
  [key: string]: unknown
}

/** 装配所需的追问选项（来自 `ResolvedPaperConfig.intake`）。 */
export interface IntakeSubOptions {
  readonly maxQuestions: number
  readonly specRel: string
}

/** 追问模块能做的全部动作。 */
export const INTAKE_ACTIONS: readonly string[] = ['start', 'ask', 'answer', 'skip', 'status', 'spec', 'done']

/** 工具执行上下文的最小面：只需要会话 cwd 与中断信号（结构上兼容宿主 `ToolExecution`）。 */
export interface IntakeExec {
  readonly signal?: AbortSignal
  readonly agent?: {
    readonly session: {
      readonly header: {
        readonly cwd?: string
      }
    }
  }
}

/** 参数表里的一项（与 `shared/define-tool.ts` 的作者侧 DSL 一致）。 */
export interface IntakeParameterSpec {
  readonly type: string
  readonly description: string
  readonly required?: true
}

/** 工具定义（零宿主运行时依赖；装配入口与测试共用同一份）。 */
export interface IntakeToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, IntakeParameterSpec>
  execute(args: IntakeArgs, exec: IntakeExec): Promise<string>
}

/** 执行层：由 `./index.ts` 注入，避免定义文件反向依赖执行文件（循环导入）。 */
export type IntakeRunner = (fs: FileSystemLike, intake: IntakeSubOptions, args: IntakeArgs, cwd: string | undefined, signal?: AbortSignal, sessionAsked?: number) => Promise<string>

/**
 * `thesis_intake` 的工具定义：参数表 + execute。
 *
 * 这是模型真正看到的接口；`execute` 把 `session_asked` 搬到位置参数后交给
 * `run()`（即 `runIntake`），保证「工具调用」与「直接调用执行层」行为完全一致。
 */
export function intakeToolDefinition(fs: FileSystemLike, intake: IntakeSubOptions, run: IntakeRunner): IntakeToolDefinition {
  return {
    name: 'thesis_intake',
    description:
      '材料到手后的逐题追问（一次只问一个问题），把学校模板/论文要求/实验数据/代码/参考文献里的模糊要求变成可证伪的意图规格，' +
      `并把"学校格式模板是否已拿到"这类材料已回答的问题标为待确认，不重复问。规格落盘到 ${intake.specRel}，每次回答后自动刷新，` +
      '作为后续写作/构建/降重/答辩的唯一依据。支持断点续问。' +
      'action：start（初始化或读取状态，返回第一个问题与进度）；ask（取下一个问题）；answer（question_id + answer，记录后返回下一个问题与进度）；' +
      'skip（跳过，必须带 reason）；status（进度/已答/未答/阻塞项）；spec（重绘并落盘规格，返回路径与阻塞项）；' +
      'done（校验必答项；不齐时拒绝并列出缺口，齐全时标记阶段完成）。返回内容有界且一次最多一个问题。',
    parameters: {
      action: { type: 'string', required: true, description: `必填：${INTAKE_ACTIONS.join(' | ')}` },
      question_id: { type: 'string', description: 'answer/skip 时必填：问题 id（如 school.template、scope.wordcount）' },
      answer: { type: 'string', description: 'answer 时必填：用户答案原文（原样记录，不做改写）' },
      reason: { type: 'string', description: 'skip 时必填：跳过理由（会写进规格的阻塞项与备注）' },
      session_asked: { type: 'number', description: `本次会话已经问过几个问题（用于执行 maxQuestions=${intake.maxQuestions} 的每轮上限；缺省 0）` },
    },
    async execute(args, exec) {
      const sessionAsked = typeof args.session_asked === 'number' && Number.isFinite(args.session_asked)
        ? Math.max(0, Math.floor(args.session_asked))
        : 0
      return await run(fs, intake, args, exec.agent?.session.header.cwd, exec.signal, sessionAsked)
    },
  }
}
