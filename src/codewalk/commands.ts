/**
 * 人类可用的 `/thesis-defense` 命令：`new`、`status`、`check`。
 *
 * 只有在组合了命令适配器时才通过 `ctx.commands` 注册（交互式部署）；纯 headless
 * 与仅 ACP 的组合没有命令注册表，直接跳过这一层表面。命令面的结果直接渲染，
 * 不进入模型历史。
 *
 * @module dsh-thesis/codewalk
 */

import type { Context } from '@deepseek-ai/cordis'
import { AiLearningEngine } from './engine.ts'
import { isLearningError } from './errors.ts'
import { runMilestoneGate } from './gate.ts'
import type {
  CommandDefinitionShape,
  CommandInvocationShape,
  CommandResultShape,
  CommandsServiceShape,
} from './host-types.ts'
import type { LearnerLevel, Milestone } from './types.ts'

const DEFAULT_LANGUAGE = 'go'
const LEVELS: readonly LearnerLevel[] = ['beginner', 'intermediate', 'advanced']

/** 会话没有工作目录时的统一答复。 */
const NO_WORKSPACE: CommandResultShape = {
  kind: 'error',
  text: '本次会话没有工作目录，无法定位代码演练状态。请在论文工作区目录里打开会话。',
}

/** 代码演练侧的子命令（与幻灯侧区分）。 */
export const CODEWALK_SUBCOMMANDS: readonly string[] = ['new', 'status', 'check']

/** 命令的展示元信息（装配层注册 `/thesis-defense` 时使用）。 */
export const CODEWALK_COMMAND_HINT =
  'new <原始项目路径> [--lang go] [--level beginner] [--module pkg] | status | check [里程碑]'

/**
 * 代码演练侧的命令处理器（由装配层在 `/thesis-defense` 下调度）。
 *
 * `rawInput` 是命令名之后的全部输入；本函数只认代码演练侧的子命令
 * （`new` / `status` / `check`），其余一律交回装配层。
 */
export async function handleCodewalkCommand(
  ctx: Context,
  engine: AiLearningEngine,
  invocation: CommandInvocationShape,
): Promise<CommandResultShape> {
  try {
    const tokens = invocation.rawInput.trim().split(/\s+/)
    const sub = tokens[0] ?? ''
    const args = tokens.slice(1)
    if (sub === 'new') return await handleNew(engine, invocation, args)
    if (sub === 'status') return await handleStatus(engine, invocation)
    if (sub === 'check') return await handleCheck(ctx, engine, invocation, args)
    return { kind: 'error', text: `未知子命令 "${sub}"；代码演练侧应为 new | status | check` }
  } catch (error) {
    if (isLearningError(error)) return { kind: 'error', text: error.message }
    const message = error instanceof Error ? error.message : String(error)
    return { kind: 'error', text: `内部错误：${message}` }
  }
}

interface NewOptions {
  path?: string
  language: string
  level: LearnerLevel
  module?: string
}

function parseNewArgs(args: readonly string[]): NewOptions {
  const options: NewOptions = { language: DEFAULT_LANGUAGE, level: 'beginner' }
  const positional: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg === '--lang' || arg === '--level' || arg === '--module') {
      const value = args[index + 1]
      if (value === undefined) continue
      if (arg === '--lang') options.language = value
      else if (arg === '--level') options.level = value as LearnerLevel
      else options.module = value
      index += 1
      continue
    }
    if (arg.startsWith('--lang=')) options.language = arg.slice('--lang='.length)
    else if (arg.startsWith('--level=')) options.level = arg.slice('--level='.length) as LearnerLevel
    else if (arg.startsWith('--module=')) options.module = arg.slice('--module='.length)
    else positional.push(arg)
  }
  const first = positional[0]
  if (first !== undefined) options.path = first
  return options
}

async function handleNew(
  engine: AiLearningEngine,
  invocation: CommandInvocationShape,
  args: readonly string[],
): Promise<CommandResultShape> {
  const options = parseNewArgs(args)
  if (options.path === undefined) {
    return {
      kind: 'error',
      text: '用法：/thesis-defense new <原始项目路径> [--lang go] [--level beginner] [--module pkg]',
    }
  }
  if (!LEVELS.includes(options.level)) {
    return { kind: 'error', text: `非法的 level "${options.level}"；应为 ${LEVELS.join(' | ')}` }
  }
  const cwd = invocation.agent.session.header.cwd
  if (cwd === undefined || cwd === '') return NO_WORKSPACE
  const state = await engine.create(cwd, {
    origin: { path: options.path, language: options.language },
    scope: { level: options.level, ...(options.module !== undefined ? { module: options.module } : {}) },
  })
  return {
    kind: 'success',
    text:
      `已为 ${options.path} 创建代码演练（${options.language}，${options.level}）。\n` +
      `${engine.describe(state)}\n` +
      `下一步：让 AI 分析该项目，用 defense_code_update 工具登记 todo 与里程碑。`,
  }
}

async function handleStatus(
  engine: AiLearningEngine,
  invocation: CommandInvocationShape,
): Promise<CommandResultShape> {
  const cwd = invocation.agent.session.header.cwd
  if (cwd === undefined || cwd === '') return NO_WORKSPACE
  const state = await engine.load(cwd)
  if (state === undefined) {
    return { kind: 'error', text: `${cwd} 下没有代码演练状态；请先执行 "/thesis-defense new <原始项目路径>"` }
  }
  return { kind: 'success', text: engine.describe(state) }
}

async function handleCheck(
  ctx: Context,
  engine: AiLearningEngine,
  invocation: CommandInvocationShape,
  args: readonly string[],
): Promise<CommandResultShape> {
  const cwd = invocation.agent.session.header.cwd
  if (cwd === undefined || cwd === '') return NO_WORKSPACE
  const state = await engine.load(cwd)
  if (state === undefined) {
    return { kind: 'error', text: `${cwd} 下没有代码演练状态；请先执行 "/thesis-defense new <原始项目路径>"` }
  }
  const milestone = pickMilestone(state.milestones, args[0])
  if (milestone === undefined) {
    return {
      kind: 'error',
      text: args[0] === undefined
        ? '当前没有 in_progress 或 failed 的里程碑，没有可检查的对象'
        : `未知里程碑 "${args[0]}"`,
    }
  }
  if (milestone.status === 'failed') engine.retryMilestone(state, milestone.id)

  const settled = await runMilestoneGate(ctx, engine, cwd, state, milestone, invocation.signal, invocation.agent.session)

  if (settled.interrupted) {
    return { kind: 'error', text: `验证门 "${settled.command.join(' ')}" 被中断；该里程碑已标记为 failed` }
  }
  if (settled.outcome.kind === 'failed') {
    return {
      kind: 'error',
      text:
        `验证门 "${settled.command.join(' ')}" 失败，退出码 ${settled.exitCode}；该里程碑已标记为 failed。\n` +
        (settled.stderr.trim() === '' ? `stdout 末尾：\n${settled.stdout}` : `stderr 末尾：\n${settled.stderr}`),
    }
  }
  if (settled.outcome.kind === 'pending-questions') {
    return {
      kind: 'success',
      text:
        `验证门 "${settled.command.join(' ')}" 通过，但仍有 ${milestone.questions.filter((question) => question.status !== 'passed').length} 个问题未通过。\n` +
        '让 AI 把追问做完；当验证门为绿且全部问题通过时，该里程碑才算 verified。',
    }
  }
  const next = state.milestones.find((entry) => entry.status === 'in_progress')
  const complete = state.phase === 'complete'
  return {
    kind: 'success',
    text:
      `验证门 "${settled.command.join(' ')}" 通过 —— 里程碑 "${milestone.id}" 已验证。\n` +
      (complete ? '全部里程碑已验证：本次代码演练完成。' : `下一个里程碑：${next?.title ?? '无'}。`),
  }
}

function pickMilestone(milestones: readonly Milestone[], requestedId: string | undefined): Milestone | undefined {
  if (requestedId !== undefined) {
    return milestones.find((milestone) => milestone.id === requestedId)
  }
  return (
    milestones.find((milestone) => milestone.status === 'in_progress') ??
    milestones.find((milestone) => milestone.status === 'failed')
  )
}
