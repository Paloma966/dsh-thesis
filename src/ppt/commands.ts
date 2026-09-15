/**
 * 斜杠命令 `/thesis-defense` 的**幻灯侧**输入解析。
 *
 * 命令名遵循 DSH 的 `[a-z][a-z0-9_-]*` 约束（kebab-case）。命令注册本身在
 * 装配层（`src/index.ts`）完成：`/thesis-defense` 同时覆盖答辩幻灯与代码演练，
 * 由装配层聚合两侧的处理器——这样 `ppt/` 与 `codewalk/` 之间没有反向依赖。
 *
 * @module dsh-thesis/ppt
 */

import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { PptOptions } from '../config.ts'
import { runPptAction, type PptArgs, type PptDeps } from './actions.ts'

async function safe(work: () => Promise<string>): Promise<CommandResult> {
  try {
    return { kind: 'success', text: await work() }
  } catch (error) {
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
  }
}

/** 幻灯侧的子命令（与代码演练侧区分）。 */
export const PPT_SUBCOMMANDS: readonly string[] = ['prepare', 'convert', 'check', 'guide']

/** 把 `/thesis-defense <输入>` 的幻灯侧部分解析成工具参数。 */
export function parsePptCommandInput(rawInput: string): PptArgs {
  const tokens = rawInput.trim().split(/\s+/).filter(t => t !== '')
  let action: PptArgs['action'] = 'outline'
  let pages: number | undefined
  let audience: PptArgs['audience']
  let force = false
  for (const token of tokens) {
    const lowered = token.toLowerCase()
    if (lowered === 'prepare' || lowered === 'outline' || lowered === 'convert' || lowered === 'check' || lowered === 'guide') {
      action = lowered === 'prepare' ? 'outline' : lowered
      continue
    }
    if (lowered === 'undergrad' || lowered === 'master') {
      audience = lowered
      continue
    }
    if (lowered === 'force' || lowered === '--force' || lowered === '-f') {
      force = true
      continue
    }
    const number = Number.parseInt(token, 10)
    if (Number.isFinite(number)) {
      pages = number
      continue
    }
    throw new Error(
      `无法识别的参数「${token}」。用法：/thesis-defense prepare [页数] [undergrad|master] [force]`
      + ' | convert | check | guide | new <原始项目路径> | status | check [里程碑]',
    )
  }
  return {
    action,
    ...(pages !== undefined ? { pages } : {}),
    ...(audience !== undefined ? { audience } : {}),
    ...(force ? { force: true } : {}),
  }
}

/**
 * 幻灯侧的命令处理器（由装配层在 `/thesis-defense` 下调度）。
 *
 * `rawInput` 仍是命令名之后的全部输入；本函数只关心幻灯侧子命令。
 */
export async function handlePptCommand(
  fs: FileSystem,
  options: { ppt: PptOptions },
  invocation: CommandInvocation,
  deps: PptDeps = {},
): Promise<CommandResult> {
  return await safe(async () => {
    const args = parsePptCommandInput(invocation.rawInput)
    const outcome = await runPptAction(fs, invocation.agent.session.header.cwd, args, options, invocation.signal, deps)
    return outcome.text
  })
}

/** 命令的展示元信息（装配层注册时使用）。 */
export const PPT_COMMAND_DESCRIPTION =
  '答辩幻灯：生成 Marp Markdown（prepare/outline）/ 执行外部转换（convert）/ 质量检查（check）/ 转换指引（guide）'
export const PPT_COMMAND_HINT = 'prepare | convert | check | guide [页数] [undergrad|master] [force]'
