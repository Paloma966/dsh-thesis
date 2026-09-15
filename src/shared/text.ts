/**
 * 纯文本启发式工具：零依赖、纯函数，被闸门、追问与跨会话事实回灌共用。
 *
 * 这里的函数只回答「这段文本里有什么」——**不含任何产品判断**。
 * 「什么样的文本应当触发闸门」属于 `gates/detect.ts`。
 *
 * @module dsh-thesis/shared/text
 */

/** 命令摘录：截断到 max 字符，用于决策理由展示（绝不无限引用命令全文）。 */
export function excerpt(text: string, max = 200): string {
  const single = text.replace(/\s+/g, ' ').trim()
  if (single.length <= max) return single
  return `${single.slice(0, max)}…（已截断，共 ${single.length} 字符）`
}

/** 从消息内容块中提取纯文本（只取 text 块）。 */
export function textOfBlocks(blocks: readonly { type: string }[]): string {
  let out = ''
  for (const block of blocks) {
    const text = (block as { type: string; text?: unknown }).text
    if (block.type === 'text' && typeof text === 'string') out += text
    out += '\n'
  }
  return out
}
