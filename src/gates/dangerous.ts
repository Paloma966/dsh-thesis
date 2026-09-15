/**
 * 不可逆操作闸门：`tools/pre-execute` 监听。
 *
 * 当模型即将执行命中高危规则的工具调用（默认只查 bash：递归删除、强制推送、
 * 数据库破坏语句、管道执行远程脚本等）时，以 ask 决策拦截——审批界面会把
 * 两个问题（最坏结果能否接受？能否回滚？）呈现给用户。
 *
 * 这是唯一不可由模型代答、也不可被提示词绕过的闸门：不可逆操作必须由人当场
 * 拍板。用户可以批准（想清楚了）或拒绝（拿到更安全的替代方案）。
 *
 * @module dsh-thesis/gates/dangerous
 */

import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { excerpt } from '../shared/text.ts'
import { compileDestructiveRules, findDestructiveHit } from './detect.ts'
import { destructiveAskReason } from './messages.ts'
import { GATE_DEFAULTS, type GateOptions } from './writing-intent.ts'

/** 决策理由中引用的命令摘录长度上限。 */
const COMMAND_EXCERPT_MAX = 200

/**
 * 安装高危操作闸门监听。
 *
 * 未命中的调用原样委托 `next()`；命中时不再调用 next（ask 决策直接返回，
 * 由审批服务决定放行与否）。直接调用 `ctx.tools.execute()` 的无模型调用
 * （exec.agent 缺失）不拦截。
 */
export function installDangerousGate(ctx: Context, config: GateOptions = {}): void {
  if (config.destructiveGate === false) return
  const toolNames = config.destructiveToolNames ?? GATE_DEFAULTS.destructiveToolNames
  const rules = compileDestructiveRules(config.destructiveRules ?? GATE_DEFAULTS.destructiveRules, pattern => {
    ctx.logger.warn(`dsh-thesis: 无效的 destructiveRules 正则已跳过: ${pattern}`)
  })

  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    if (exec.agent === undefined) return next()
    if (!toolNames.includes(exec.name)) return next()

    const args = exec.arguments as { command?: unknown } | undefined
    const command = args !== undefined && typeof args.command === 'string' ? args.command : undefined
    if (command === undefined) return next()

    const hit = findDestructiveHit(command, rules)
    if (hit === undefined) return next()

    return { kind: 'ask', reason: destructiveAskReason(hit.label, excerpt(command, COMMAND_EXCERPT_MAX)) }
  })
}
