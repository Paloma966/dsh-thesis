/**
 * 写作意图闸门：`agent/pre-step` 监听。
 *
 * 当一步的新消息来自用户、看起来要开始写论文、且没有带写作要求/授权短语时，
 * 向该步的消息末尾注入一条插件来源的指令——模型必须先用 `thesis_intake`
 * 把要求问清楚（一次一个问题）才能动笔。
 *
 * 这是对「AI 太顺从」的直接矫正：写错方向的代价是整章重写，而问清楚只要十分钟。
 * 闸门不替用户思考，只强制模型成为提问者、强制用户成为要求的唯一裁决者。
 *
 * @module dsh-thesis/gates/prompt
 */

import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { excerpt, textOfBlocks } from '../shared/text.ts'
import { compileBypassMarkers, compileCriteriaMarkers, compilePatterns, isUnguardedWritingIntent } from './detect.ts'
import { makeGateMessage } from './messages.ts'
import { GATE_DEFAULTS, type GateOptions } from './writing-intent.ts'

/** 注入指令引用的原指令摘录长度上限：只给模型上下文，不复制全文。 */
const INTENT_EXCERPT_MAX = 160

/**
 * 安装写作意图闸门监听。
 *
 * 永远先 `await next()` 再决策：默认决策里带有系统提示上下文，
 * 注入必须折叠在其上，且任何异常都不允许抛进 agent 循环。
 */
export function installWritingGate(ctx: Context, config: GateOptions = {}): void {
  if (config.writingGate === false) return
  const patterns = compilePatterns(config.writingIntentPatterns ?? GATE_DEFAULTS.writingIntentPatterns, pattern => {
    ctx.logger.warn(`dsh-thesis: 无效的 writingIntentPatterns 正则已跳过: ${pattern}`)
  })
  const criteriaMarkers = compileCriteriaMarkers(config.criteriaMarkers ?? GATE_DEFAULTS.criteriaMarkers, marker => {
    ctx.logger.warn(`dsh-thesis: 无效的 criteriaMarkers 正则已跳过: ${marker}`)
  })
  const bypassMarkers = compileBypassMarkers(config.bypassMarkers ?? GATE_DEFAULTS.bypassMarkers, marker => {
    ctx.logger.warn(`dsh-thesis: 无效的 bypassMarkers 正则已跳过: ${marker}`)
  })
  const maxQuestions = config.maxQuestions ?? GATE_DEFAULTS.maxQuestions

  ctx.on('agent/pre-step', async (payload, next): Promise<PreStepDecision> => {
    const downstream = await next()
    if (downstream.kind !== 'enter') return downstream

    const messages = payload.messages
    const last = messages[messages.length - 1]
    // 只对「用户刚发出的新消息」反应；工具结果、模型消息与插件注入都不触发。
    // 防重入因此只落在「最近一条消息」上：上一轮注入的插件消息会被新的用户
    // 消息顶到历史里，于是每轮新用户消息都会重新评估，历史里存在注入不会
    // 永久屏蔽后续真正模糊的指令。
    if (last === undefined || last.source.kind !== 'user') return downstream

    const text = textOfBlocks(last.content)
    if (!isUnguardedWritingIntent(text, patterns, criteriaMarkers, bypassMarkers)) return downstream

    const injected = makeGateMessage(excerpt(text, INTENT_EXCERPT_MAX), maxQuestions)
    return { kind: 'enter', messages: [...downstream.messages, injected] }
  })
}
