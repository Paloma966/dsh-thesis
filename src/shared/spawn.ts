/**
 * 子进程调用的统一助手：**退出码必须等于 0 才算成功**，且不依赖被限制的管道 stdio。
 *
 * 两个真实教训：
 *
 * 1. **`status === null` 不是成功**。子进程从未启动（`EPERM`）、被信号杀死或被
 *    `timeout` 掐断时，`spawnSync` 返回 `status: null`。原先的写法是
 *    `if (status !== 0) 失败`，`null !== 0` 成立所以能挡住——但 `if (status === 0) 成功`
 *    这类写法会把「没跑起来」当成成功。本模块统一用 {@link spawnOk} 判定，
 *    并把 `error`（含 `EPERM`）与退出码一起回报，绝不静默。
 *
 * 2. **管道 stdio 在某些受限环境被拒**。沙箱/受限宿主下 `stdio: 'pipe'` 会直接
 *    `EPERM`，此时 `git init` 之类的调用一律失败。因此默认用 `'ignore'`：
 *    退出码仍可用，但拿不到 stdout/stderr——需要输出内容的调用（如 `git log`）
 *    必须显式传 `capture: true` 并在无输出时如实降级，而不是假装拿到结果。
 *
 * @module dsh-thesis/shared/spawn
 */

import { spawnSync } from 'node:child_process'

export interface SpawnOptions {
  readonly cwd?: string
  readonly timeoutMs?: number
  /** 是否需要 stdout/stderr 内容（默认 false；受限环境下管道 stdio 可能被拒）。 */
  readonly capture?: boolean
}

export interface SpawnOutcome {
  /** 退出码为 0 时为 true；子进程未启动/被杀死（status=null）一律为 false。 */
  readonly ok: boolean
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
  /** 子进程未能启动时的原因（如 `Error: spawnSync git EPERM`）。 */
  readonly error: string | undefined
  readonly timedOut: boolean
}

/** 运行一条命令并给出**可靠的成功判定**与尽可能完整的诊断信息。 */
export function spawnCommand(command: string, args: readonly string[], options: SpawnOptions = {}): SpawnOutcome {
  const capture = options.capture === true
  const result = spawnSync(command, [...args], {
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'ignore',
    ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
  })
  const error = result.error === undefined ? undefined : String(result.error)
  // Node 在 timeout 触发时会设置 error.code === 'ETIMEDOUT'（或 signal 为 SIGTERM）。
  const timedOut = error !== undefined && /ETIMEDOUT|timed out/i.test(error)
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error,
    timedOut,
  }
}

/** 失败原因的可读描述（写进工具返回值，绝不出现「失败但什么都不说」）。 */
export function describeFailure(command: string, outcome: SpawnOutcome): string {
  const head = `${command} 未能完成`
  if (outcome.error !== undefined) return `${head}：${outcome.error}`
  if (outcome.timedOut) return `${head}：超时被终止`
  const detail = (outcome.stderr.trim() || outcome.stdout.trim()).split('\n')[0] ?? ''
  return `${head}：退出码 ${outcome.status ?? 'null'}${detail === '' ? '' : ` —— ${detail}`}`
}
