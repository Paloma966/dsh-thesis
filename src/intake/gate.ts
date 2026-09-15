/**
 * 意图规格闸门：`agent/pre-step` 监听。
 *
 * 场景：用户说「开始写第三章」。如果意图规格还没立全（学校格式、字数、查重阈值、
 * 时间线都还没确认），此时写出来的正文大概率要重写——这正是本插件要消灭的返工。
 *
 * 与 `intake/` 其它部分的分工：判定规则在 `gate-rules.ts`（纯函数），这里只做
 * 「读规格 → 判定 → 注入」的胶水。三条设计底线：
 * 便宜（只在用户新消息命中写作意图时才读文件，且按 agent 缓存 60 秒）、
 * 面向人（只提醒模型去问，绝不替用户作答）、有终止条件（规格就绪即静默，
 * 用户说「直接写」即放行）。
 *
 * @module dsh-thesis/intake/gate
 */

import type { Context } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import { findThesisRoot } from '../paper/lib/project.ts'
import { isMissingError } from '../shared/fs-errors.ts'
import { textOfBlocks } from '../shared/text.ts'
import { isBypassed, isWritingIntent, judgeSpec, makeIntakeGateMessage, type SpecStatus } from './gate-rules.ts'

/** 每个 agent 的规格状态缓存时长（毫秒）：避免每一步都读盘。 */
const CACHE_TTL_MS = 60_000

interface CachedStatus {
  readonly at: number
  readonly status: SpecStatus | undefined
}

/**
 * 安装意图规格闸门。
 *
 * `status === undefined` 表示「不在论文工作区里」，此时不介入——插件在别人的仓库、
 * 纯聊天场景里都必须安静。
 */
export function installIntakeGate(ctx: Context, options: { specRel: string }): void {
  const cache = new WeakMap<object, CachedStatus>()

  ctx.on('agent/pre-step', async (payload, next) => {
    const downstream = await next()
    if (downstream.kind !== 'enter') return downstream

    const messages = payload.messages
    const last = messages[messages.length - 1]
    // 只对「用户刚发出的新消息」反应：工具结果、模型消息、插件注入都不触发。
    if (last === undefined || last.source?.kind !== 'user') return downstream

    const text = textOfBlocks(last.content)
    if (!isWritingIntent(text) || isBypassed(text)) return downstream

    const agent = payload.agent as object | undefined
    const cwd = (payload.agent as { session?: { header?: { cwd?: string } } } | undefined)?.session?.header?.cwd
    if (agent === undefined || typeof cwd !== 'string' || cwd === '') return downstream

    const cached = cache.get(agent)
    let status: SpecStatus | undefined
    if (cached !== undefined && Date.now() - cached.at < CACHE_TTL_MS) {
      status = cached.status
    } else {
      status = await readSpecStatus(ctx, cwd, options.specRel, payload.signal)
      cache.set(agent, { at: Date.now(), status })
    }

    if (status === undefined || status.kind === 'ready') return downstream
    const injected = makeIntakeGateMessage(status, options.specRel, `paper-intake-gate-${Date.now()}`)
    return { kind: 'enter', messages: [...downstream.messages, injected] }
  })
}

/**
 * 读取规格状态。工作区不存在时返回 `undefined`（不介入）；规格文件不存在返回 `missing`。
 * 读盘异常一律视为「不介入」——闸门永不把异常抛进 agent 循环。
 */
async function readSpecStatus(
  ctx: Context,
  cwd: string,
  specRel: string,
  signal?: AbortSignal,
): Promise<SpecStatus | undefined> {
  try {
    const root = await findThesisRoot(ctx.fs, cwd, signal)
    if (root === null) return undefined
    let body: string | undefined
    try {
      body = await ctx.fs.readText(await ctx.fs.resolve(join(root, specRel), { signal }), signal)
    } catch (error) {
      // 只有「规格文件确实不存在」才当作 missing（继续提醒去追问）；
      // 读失败（权限/IO/取消）时无话可说，选择不介入——闸门是增益功能，绝不误报。
      if (!isMissingError(error)) return undefined
      body = undefined
    }
    return judgeSpec(body)
  } catch {
    return undefined
  }
}
