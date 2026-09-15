/**
 * 共享的验证门执行逻辑：通过 `ctx.shell` 跑一个里程碑的验证命令，把结论折进
 * 引擎（记录 + 状态 + 落盘），再把结算后的结果交回给调用方渲染。
 *
 * 人类的 `/thesis-defense check` 命令与模型侧的 `defense_code_update` `check_gate` 动作共用这段
 * 逻辑，因此两个表面永远不会对「什么叫 verified」产生分歧。
 *
 * @module dsh-thesis/codewalk
 */

import type { Context } from '@deepseek-ai/cordis'
import { AiLearningEngine } from './engine.ts'
import { LearningError } from './errors.ts'
import type { ShellServiceShape } from './host-types.ts'
import type { GateOutcome, LearningState, Milestone } from './types.ts'

export const GATE_TIMEOUT_MS = 120_000

/** 一次验证门执行结算后的结果。 */
export interface MilestoneGateOutcome {
  readonly outcome: GateOutcome
  readonly command: readonly string[]
  readonly exitCode: number
  readonly interrupted: boolean
  readonly stdout: string
  readonly stderr: string
}

/**
 * 跑 `milestone` 的有效验证门，记录它，持久化状态，并返回结算后的结论。
 * 验证门失败会自动重新打开该里程碑 —— 修完再跑一次检查就是预期的重试回路。
 *
 * `session`（调用方 agent 的会话，若有）会喂给宿主的逐调用沙箱策略解析，因此
 * 带沙箱的 shell 执行器能拿到它需要的策略，而不是退回到部署默认值。
 */
export async function runMilestoneGate(
  ctx: Context,
  engine: AiLearningEngine,
  cwd: string,
  state: LearningState,
  milestone: Milestone,
  signal: AbortSignal,
  session?: unknown,
): Promise<MilestoneGateOutcome> {
  const shell = ctx.get('shell') as ShellServiceShape | undefined
  if (shell === undefined) {
    throw new LearningError('SHELL_MISSING', '没有组合 shell 执行器，无法运行验证门')
  }
  const gate = milestone.gate ?? state.gates[state.origin.language]
  if (gate === undefined) {
    throw new LearningError('GATE_UNKNOWN', `语言 "${state.origin.language}" 没有记录验证门`)
  }
  if (milestone.status === 'failed') engine.retryMilestone(state, milestone.id)
  const command = [...gate.build]
  const started = Date.now()
  const result = await shell.run({
    command: command.join(' '),
    workdir: cwd,
    timeoutMs: GATE_TIMEOUT_MS,
    stdoutMaxBytes: engine.config.maxCapturedOutput,
    signal,
    sandboxPolicy: resolveSandboxPolicy(ctx, session),
  })
  const durationMs = Date.now() - started
  const interrupted = result.timedOut || result.aborted
  const exitCode = interrupted ? 1 : (result.exitCode ?? 1)
  const outcome = engine.recordGate(state, milestone.id, {
    command,
    exitCode,
    stdout: result.stdout.text,
    stderr: result.stderr.text,
    durationMs,
  })
  await engine.save(cwd, state)
  return { outcome, command, exitCode, interrupted, stdout: result.stdout.text, stderr: result.stderr.text }
}

interface SandboxPolicyServiceShape {
  resolve(request?: { session?: unknown }): unknown
}

/** 宿主组合了沙箱策略服务时，解析本次调用的策略。 */
function resolveSandboxPolicy(ctx: Context, session: unknown): unknown {
  const service = ctx.get('sandboxPolicy') as SandboxPolicyServiceShape | undefined
  if (service === undefined) return undefined
  return service.resolve(session === undefined ? {} : { session })
}
