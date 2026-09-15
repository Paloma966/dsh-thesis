/**
 * 斜杠命令的聚合层。
 *
 * `/thesis-defense` 同时覆盖**答辩幻灯**与**代码演练**两块能力，因此它的注册
 * 放在装配层：`ppt/` 与 `codewalk/` 各自导出处理器，由本文件按子命令调度，
 * 两个模块之间没有反向依赖（见 DESIGN.md 的分层规则）。
 *
 * 命令只做薄封装：解析输入 → 交给对应模块的纯逻辑入口，因此命令行为与工具完全一致。
 *
 * @module dsh-thesis/commands
 */

import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { Context } from '@deepseek-ai/cordis'
import { CODEWALK_COMMAND_HINT, handleCodewalkCommand } from './codewalk/commands.ts'
import type { AiLearningEngine } from './codewalk/engine.ts'
import { handlePptCommand, PPT_COMMAND_DESCRIPTION, PPT_COMMAND_HINT, PPT_SUBCOMMANDS } from './ppt/commands.ts'
import type { PptOptions } from './config.ts'
import type { PptDeps } from './ppt/actions.ts'

/** 答辩命令两侧的子命令集合（仅用于错误提示）。 */
export const DEFENSE_COMMAND_HINT = `${PPT_COMMAND_HINT} | ${CODEWALK_COMMAND_HINT}`

/**
 * 注册 `/thesis-defense`：答辩幻灯 + 代码演练。
 *
 * 幻灯侧子命令：`prepare`（= outline）/ `convert` / `check` / `guide`；
 * 代码演练侧子命令：`new` / `status` / `check`。`check` 两侧同名，按是否给出
 * 里程碑参数区分——幻灯侧的 check 不接受位置参数。
 *
 * headless/ACP 组合没有命令面时静默跳过。
 */
export function registerDefenseCommand(
  ctx: Context,
  options: { ppt: PptOptions },
  deps: PptDeps = {},
): void {
  const commands = ctx.get('commands') as { register(definition: unknown): unknown } | undefined
  if (commands === undefined) return
  commands.register({
    name: 'thesis-defense',
    description: `答辩准备：幻灯与演练。${PPT_COMMAND_DESCRIPTION}；代码演练：new <原始项目路径> | status | check [里程碑]`,
    input: { hint: DEFENSE_COMMAND_HINT },
    handler: async (invocation: CommandInvocation): Promise<CommandResult> => {
      return await dispatchDefenseCommand(ctx, options, invocation, deps)
    },
  })
}

/** 按子命令把一次 `/thesis-defense` 调用分派到幻灯侧或代码演练侧。 */
export async function dispatchDefenseCommand(
  ctx: Context,
  options: { ppt: PptOptions },
  invocation: CommandInvocation,
  deps: PptDeps = {},
): Promise<CommandResult> {
  const tokens = invocation.rawInput.trim().split(/\s+/).filter(token => token !== '')
  const sub = (tokens[0] ?? 'prepare').toLowerCase()
  if (PPT_SUBCOMMANDS.includes(sub)) {
    return await handlePptCommand(ctx.fs, options, invocation, deps)
  }
  if (sub === 'new' || sub === 'status' || (sub === 'check' && tokens.length > 1)) {
    const engine = ctx.get('paperCodeWalkthrough') as AiLearningEngine | undefined
    if (engine === undefined) {
      return { kind: 'error', text: '代码演练引擎未装配：请确认插件配置里 codeWalkthrough 已启用。' }
    }
    return await handleCodewalkCommand(ctx, engine, invocation)
  }
  if (sub === 'check') {
    // 无里程碑参数的 check 属于幻灯侧质量检查。
    return await handlePptCommand(ctx.fs, options, invocation, deps)
  }
  return {
    kind: 'error',
    text: `未知子命令「${sub}」。可用：${DEFENSE_COMMAND_HINT}`,
  }
}
