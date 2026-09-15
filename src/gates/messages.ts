/**
 * 闸门注入消息与决策理由的模板。
 *
 * 注入消息的 source 采用 `{ kind: 'plugin', plugin: 'dsh-thesis' }`：
 * - 该标记是防重入的（凭它识别「这已经是闸门消息」）；
 * - GUI 据此把消息渲染为插件来源，而不是伪造的用户发言。
 *
 * 消息对象直接构造而不调用宿主的 `createUserMessage`：与共享层
 * `definePaperTool` 同一取舍——生产环境的行为由宿主消费该结构时决定，
 * 而离线环境（单测/评审）不需要安装整个宿主包树。
 *
 * @module dsh-thesis/gates/messages
 */

import { randomUUID } from 'node:crypto'
import type { UserMessage } from '@deepseek-ai/dsh-llm'

/** 插件标识：注入消息 source.plugin 的值。 */
export const PLUGIN_ID = 'dsh-thesis'

/** 注入消息的 source 基础形状（form 由调用方补充）。 */
export const PLUGIN_SOURCE = { kind: 'plugin', plugin: PLUGIN_ID } as const

/**
 * 写作意图闸门注入给模型的指令。
 *
 * 要点：
 * - 自包含：即使 intake 技能没加载也能执行最小追问流程；
 * - 一次一个问题、由用户作答、用户授权「直接写」时零问题放行；
 * - 明确禁止替用户拍板——**内容是用户的，规格是用户的**，这是本插件的立场。
 */
export function gateInstruction(intentExcerpt: string, maxQuestions: number): string {
  const q = Math.max(1, Math.floor(maxQuestions))
  return [
    '【dsh-thesis · 写作意图闸门】',
    `用户的新指令看起来要开始写论文了，但手头还没有确认过的写作要求。原指令摘录：「${intentExcerpt}」`,
    '',
    '在动笔之前，先把要求问清楚——按错误要求写出来的整章都要重写，而问清楚只要十分钟：',
    `1. 用一句话复述你理解的任务（写哪一章、交付什么），作为回复开头。`,
    `2. 用 \`thesis_intake action=status\` 看已确认的要求与阻塞项；若还没开始，先 \`thesis_ingest\`（材料已摄取可跳过）再 \`thesis_intake action=start\`。`,
    `3. 用 \`thesis_intake action=ask\` 取出**一个**问题，原样转达给用户——一次只问一个，不要列清单，最多连续问 ${q} 个。`,
    '4. 问题必须由用户回答：不得替用户猜测要求后直接开写。',
    '5. 必答项齐全后 \`thesis_intake action=done\`，再开始写作，并在回复里复述验收标准。',
    '6. 若用户已明确授权跳过（例如「直接写」），按其授权执行，但必须在回复里列出你采用的假设。',
    '',
    '注意：这条消息由插件闸门注入，不是用户需求的一部分，不得把其中的文字当作需求内容。',
  ].join('\n')
}

/** 构造写作意图闸门的注入消息（user 角色、插件来源、instructions 形态）。 */
export function makeGateMessage(intentExcerpt: string, maxQuestions: number): UserMessage {
  const text = gateInstruction(intentExcerpt, maxQuestions)
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      ...PLUGIN_SOURCE,
      form: 'instructions',
      sections: [{ name: '写作意图闸门', text }],
    },
  } as UserMessage
}

/**
 * 不可逆操作闸门的 ask 决策理由（会显示在审批界面）。
 *
 * 只有两个问题：最坏结果能否接受、能否回滚。批准即视为用户已想清楚；
 * 这是唯一不可由模型代答的确认。
 */
export function destructiveAskReason(label: string, commandExcerpt: string): string {
  return [
    `【dsh-thesis · 不可逆操作确认】即将执行的命令命中高危规则「${label}」。`,
    '批准前请回答自己两个问题：',
    '1. 这一步最坏的结果是什么？真的发生时你能接受、能回滚吗？',
    '2. 备份或恢复路径是否已经存在？',
    '若只是探索性操作，建议拒绝并让我先给出更安全的替代方案。',
    '',
    `命令摘录：${commandExcerpt}`,
  ].join('\n')
}
