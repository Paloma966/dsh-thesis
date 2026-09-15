/**
 * pre-step 进度注入：当会话 cwd 下存在进行中的代码演练时，每个 agent step 都会
 * 收到一张紧凑的进度卡片，因此无论是续接的会话还是全新的会话，都不必从零重建
 * 这次演练的全部上下文。
 *
 * 卡片只在状态文件确实变化时才重新注入（按 agent 用 `updatedAt` 跟踪），把
 * token 开销压到「每次状态变更一张卡」。
 *
 * @module dsh-thesis/codewalk
 */

import type { Context } from '@deepseek-ai/cordis'
import { AiLearningEngine } from './engine.ts'
import { newMessageId } from './tools.ts'
import type { InjectedUserMessageShape, PreStepDecisionShape, PreStepPayloadShape } from './host-types.ts'

/** 为一份状态快照构造注入用的进度消息。 */
export function buildProgressMessage(state: Awaited<ReturnType<AiLearningEngine['load']>> & object): InjectedUserMessageShape {
  const text = [
    '当前工作区有一个进行中的代码演练（把自己的系统拆成讲得清的模块，并用可评分的追问确认你答辩时讲得出实现细节）。请带学生把它走完。',
    '',
    '和学生一起推进：带他做完当前里程碑的 todo，逐个提出追问，先沿提示阶梯升级再公布答案，并对照期望要点评分。用 defense_code_status、defense_code_next、defense_code_update 三个工具；只有学生说“做完了”才跑 "/thesis-defense check <milestone>"。',
    '',
  ].join('\n')
  const full = `${text}${JSON.stringify(state, null, 2)}`
  return {
    id: newMessageId(),
    role: 'user',
    content: [{ type: 'text', text: full }],
    source: {
      kind: 'plugin',
      plugin: 'dsh-thesis',
      form: 'snapshot',
      sections: [{ name: '代码演练进度', text: full }],
    },
  }
}

/** 注册 pre-step 监听器；只在状态变化时重新注入。 */
export function registerPreStep(ctx: Context, engine: AiLearningEngine): void {
  const lastInjected = new WeakMap<object, number>()
  // 宿主的 `agent/pre-step` waterfall 由本 bundle 无法安装的包声明，
  // 因此事件名按无类型方式派发。
  const on = ctx.on.bind(ctx) as (
    name: string,
    listener: (payload: unknown, next: () => Promise<PreStepDecisionShape>) => Promise<PreStepDecisionShape>,
    options?: { prepend?: boolean },
  ) => unknown
  on(
    'agent/pre-step',
    async (payload: unknown, next: () => Promise<PreStepDecisionShape>): Promise<PreStepDecisionShape> => {
      const { agent, signal } = payload as PreStepPayloadShape
      const decision = await next()
      if (decision.kind === 'reject' || signal.aborted) return decision
      const cwd = agent?.session?.header?.cwd
      if (typeof cwd !== 'string') return decision
      let state: Awaited<ReturnType<AiLearningEngine['load']>>
      try {
        state = await engine.load(cwd)
      } catch {
        return decision
      }
      if (state === undefined || state.phase === 'complete') return decision
      if (lastInjected.get(agent) === state.updatedAt) return decision
      lastInjected.set(agent, state.updatedAt)
      return { kind: 'enter', messages: [...decision.messages, buildProgressMessage(state)] }
    },
    { prepend: true },
  )
}
