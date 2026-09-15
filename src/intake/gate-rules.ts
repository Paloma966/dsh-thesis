/**
 * 入口闸门的判定规则（纯函数，可独立单测）。
 *
 * 闸门要回答两个问题：
 * 1. 用户这句话是不是「要开始写论文」？（而不是在聊天、问问题、改格式）
 * 2. 论文工作区里的意图规格立住了没有？（缺失 / 仍有阻塞项 / 已就绪）
 *
 * 只有 1 为真且 2 为「未就绪」时才注入追问指令——宁漏勿错：闸门的误报代价是
 * 多问一句「要不要先确认要求」，漏报代价是整章按错误要求重写。
 *
 * @module dsh-thesis/intake/gate-rules
 */

/** 「要开始写正文/开题报告」的意图模式（中英文）。 */
const WRITING_INTENT_PATTERNS: readonly RegExp[] = [
  // 中文：写/生成/起草 + 论文/正文/章节/开题/中期
  /(写|生成|起草|撰写|接着写|继续写|开始写)[^。！？\n]{0,12}(论文|正文|章节|第[一二三四五六七八九十0-9]{1,3}章|开题报告|任务书|中期报告|文献综述|摘要)/,
  // 中文：直接点名章节文件
  /\b0[1-7]-[^\s，。]{2,12}\.md\b/,
  // 英文：write/draft/generate + thesis/paper/chapter
  /\b(write|draft|generate|compose)\b[^.\n]{0,24}\b(thesis|paper|chapter|abstract|proposal)\b/i,
]

/** 用户显式授权「不用问，直接写」的短语：命中即放行。 */
const BYPASS_PATTERNS: readonly RegExp[] = [
  /直接(写|生成|做)/,
  /不用问|别问了|不需要问|跳过追问|跳过提问|无需澄清/,
  /just (write|do it)/i,
]

/**
 * 意图规格里代表「还没定下来」的文本标记。
 *
 * 主判据是**结构**（见 {@link judgeSpec} 里对「阻塞项」一节的读取），这几个字面量
 * 只作为回退：规格可能是用户手写的、或由旧版本渲染的，那时没有标准小节。
 */
const BLOCKING_MARKERS: readonly string[] = [
  '未知（需补）',
  '- [ ]',
]

/** 「阻塞项」小节的标题行（由 `intake/spec.ts` 渲染；连标题整行一起匹配，避免把标题后半截当成内容行）。 */
const BLOCKER_HEADING = /^##[^\n]*阻塞项[^\n]*/m

/** 阻塞项小节里的「无」声明。 */
const NO_BLOCKER_TEXT = /^无[。.．]/

/** 是否在要求「开始写」。 */
export function isWritingIntent(text: string): boolean {
  return WRITING_INTENT_PATTERNS.some(pattern => pattern.test(text))
}

/** 用户是否显式授权跳过追问。 */
export function isBypassed(text: string): boolean {
  return BYPASS_PATTERNS.some(pattern => pattern.test(text))
}

/** 规格就绪状态的判定结果。 */
export type SpecStatus =
  | { readonly kind: 'missing' }
  | { readonly kind: 'blocked'; readonly reason: string }
  | { readonly kind: 'ready' }

/**
 * 判定意图规格的状态。
 *
 * 判据顺序（越靠前越权威）：
 * 1. **结构判据**：`## 阻塞项…` 小节的第一行内容——`无。…` 表示已收敛，
 *    是表格/其它内容则表示仍有必答项未答或格式待修正。这条与 `intake/spec.ts`
 *    的渲染契约绑定，并且由 `tests/intake-convergence.test.ts` 端到端守住。
 * 2. **文本回退**：`未知（需补）` / 未勾选项 `- [ ]`（用户手写或旧版规格）。
 *
 * @param specText - 规格文件内容；`undefined` 表示文件不存在。
 */
export function judgeSpec(specText: string | undefined): SpecStatus {
  if (specText === undefined || specText.trim() === '') return { kind: 'missing' }

  const headingMatch = BLOCKER_HEADING.exec(specText)
  if (headingMatch !== null) {
    const rest = specText.slice(headingMatch.index + headingMatch[0].length)
    const firstLine = rest
      .split('\n')
      .map(line => line.trim())
      .find(line => line !== '' && !line.startsWith('<!--'))
    if (firstLine !== undefined && !NO_BLOCKER_TEXT.test(firstLine)) {
      return { kind: 'blocked', reason: `规格的「阻塞项」一节非空：${firstLine.slice(0, 80)}` }
    }
    // 小节存在且为空/为「无」：继续走文本回退，防止同文档别处还有未勾选项。
  }

  const unchecked = (specText.match(/^\s*-\s*\[ \]/gm) ?? []).length
  if (unchecked > 0) {
    return { kind: 'blocked', reason: `规格里仍有 ${unchecked} 个未勾选项` }
  }
  const marker = BLOCKING_MARKERS.find(candidate => candidate !== '- [ ]' && specText.includes(candidate))
  if (marker !== undefined) return { kind: 'blocked', reason: `规格里仍有「${marker}」标记` }
  return { kind: 'ready' }
}

/** 闸门注入给模型的指令（自包含：即使 intake 技能没加载也能执行最小流程）。 */
export function intakeGateInstruction(status: SpecStatus, specRel: string): string {
  const head = status.kind === 'missing'
    ? `这个论文工作区里还没有 \`${specRel}\`（意图规格）。`
    : `\`${specRel}\` 还没有立稳：${status.kind === 'blocked' ? status.reason : ''}。`
  return [
    '【dsh-thesis · 意图规格闸门】',
    `${head}用户现在的要求是「开始写论文」，但写之前必须先把要求问清楚——按错误要求写出来的整章都要重写。`,
    '',
    '请这样做（**不要**直接开始写正文）：',
    `1. 先跑 \`thesis_ingest\`（若材料还没摄取过），再用 \`thesis_intake action=start\` 读取当前进度；`,
    '2. 用 `thesis_intake action=ask` 取出**一个**问题，原样转达给用户——一次只问一个，不要列清单；',
    '3. 用户回答后用 `thesis_intake action=answer` 记录，它会自动刷新规格并给出下一个问题；',
    '4. 必答项齐全后 \`thesis_intake action=done\`，再开始写作，并依据规格向用户复述验收标准；',
    '5. 若用户已明确表示不用问（例如「直接写」），则按其授权执行，但要在回复里列出你采用的假设。',
    '',
    '这条消息由插件闸门注入，不是用户需求的一部分，不得当作需求内容。',
  ].join('\n')
}

/** 构造注入消息（user 角色、插件来源；与 learn 的进度卡同一形态）。 */
export function makeIntakeGateMessage(status: SpecStatus, specRel: string, id: string): {
  id: string
  role: 'user'
  content: Array<{ type: 'text'; text: string }>
  source: { kind: string; plugin: string; form: string; sections: Array<{ name: string; text: string }> }
} {
  const text = intakeGateInstruction(status, specRel)
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: 'plugin',
      plugin: 'dsh-thesis',
      form: 'instructions',
      sections: [{ name: '意图规格闸门', text }],
    },
  }
}
