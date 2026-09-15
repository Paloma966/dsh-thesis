/**
 * 记忆回灌：把「用户已知的稳定事实」在相关时自动放回上下文。
 *
 * 只提供 `fact_search/remember/context` 三个工具的跨会话事实是**被动**的——模型得先想起来去查。
 * 真实使用里最常发生的是：用户上次说过「我们学校要求页边距 3cm、查重阈值 20%」，
 * 这次新开会话问「帮我写绪论」，模型不知道这条约束，于是白写一版。
 *
 * 所以这里补一个 `agent/pre-step` 监听：当用户这句话与事实库里的 Key/Value 有词面重叠时，
 * 注入一张**有界**的事实卡片（默认最多 4 条 / 600 字符）。四条护栏：
 *
 * 1. **只在相关时出现**：没有任何关键词命中就一个字节都不注入（避免每条消息都塞满事实）；
 * 2. **有界**：条数与字符数都封顶，且明确标注「可能过时，冲突时以用户当前说法为准」；
 * 3. **不重复**：按 agent 记住上次注入时的事实指纹（最大 updatedAt + 条数），未变化不再注入；
 * 4. **永不抛进 agent 循环**：取事实、算关键词、渲染全部包在 try 里。
 *
 * @module dsh-thesis/memory/recall
 */

import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { textOfBlocks } from '../shared/text.ts'
import type { MemoryEntry, MemoryService } from './service.ts'

/** 记忆回灌参数。 */
export interface RecallOptions {
  /** 单次最多注入几条记忆。 */
  maxEntries: number
  /** 注入卡片的最大字符数（含标题与说明）。 */
  maxChars: number
  /** 参与匹配的关键词最短长度。 */
  minKeywordLength: number
}

/** 出厂默认值（与 `PAPER_DEFAULTS.recall` 保持一致，单一来源见 `src/config.ts`）。 */
export const RECALL_DEFAULTS: RecallOptions = { maxEntries: 4, maxChars: 600, minKeywordLength: 2 }

/** 停用词（中英混合，只去最吵的一批；不求语言学完备）。 */
const STOP_WORDS: ReadonlySet<string> = new Set([
  '的', '了', '是', '在', '我', '你', '他', '她', '它', '们', '这', '那', '有', '和', '与', '或',
  '把', '被', '让', '给', '对', '为', '从', '到', '就', '都', '也', '还', '很', '要', '会', '能',
  '一个', '什么', '怎么', '如何', '可以', '需要', '现在', '我们', '你们', '他们', '这个', '那个',
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'to', 'of', 'in', 'on', 'for', 'and', 'or',
  'it', 'this', 'that', 'with', 'my', 'me', 'you', 'we', 'please', 'help',
])

/**
 * 提取用于匹配的关键词：中文按 2-gram 滑窗、拉丁按词，去停用词并按长度降序（长词更具体）。
 *
 * 中文没有空格，直接用整句匹配会永远命中不了；用 2-gram 能把「查重阈值」拆成
 * 「查重」「重阈」「阈值」这样的片段，与记忆里的同名字段天然对齐。
 */
export function keywordsOf(text: string, minLength = RECALL_DEFAULTS.minKeywordLength): string[] {
  const found = new Set<string>()
  const latin = text.toLowerCase().match(/[a-z][a-z0-9_.-]{1,30}/g) ?? []
  for (const word of latin) {
    if (!STOP_WORDS.has(word) && word.length >= minLength) found.add(word)
  }
  const han = text.match(/[\u4e00-\u9fa5]{2,}/g) ?? []
  for (const run of han) {
    if (run.length <= 4) {
      if (!STOP_WORDS.has(run)) found.add(run)
      continue
    }
    for (let i = 0; i + 2 <= run.length; i += 1) {
      const gram = run.slice(i, i + 2)
      if (!STOP_WORDS.has(gram)) found.add(gram)
    }
  }
  return [...found].sort((a, b) => b.length - a.length || a.localeCompare(b)).slice(0, 24)
}

/** 一条记忆与关键词集合的重叠得分（命中数为主，置信度与更新时间作微调）。 */
export function scoreEntry(entry: MemoryEntry, keywords: readonly string[]): number {
  const haystack = `${entry.key}\n${entry.value}`.toLowerCase()
  let hits = 0
  for (const keyword of keywords) {
    if (haystack.includes(keyword.toLowerCase())) hits += 1
  }
  if (hits === 0) return 0
  return hits + entry.confidence * 0.01
}

/**
 * 选出与关键词相关的记忆：至少命中 1 个词，按得分降序，同分取更新更近的，截断到上限。
 */
export function selectRelevant(
  entries: readonly MemoryEntry[],
  keywords: readonly string[],
  maxEntries: number = RECALL_DEFAULTS.maxEntries,
): MemoryEntry[] {
  return entries
    .map(entry => ({ entry, score: scoreEntry(entry, keywords) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || b.entry.updatedAt - a.entry.updatedAt)
    .slice(0, Math.max(0, maxEntries))
    .map(item => item.entry)
}

/** 卡片正文（不含 source 包装）。 */
export function renderRecallCard(entries: readonly MemoryEntry[], maxChars: number): string {
  const header = '【已确认事实 · dsh-thesis】以下是你以前确认过的稳定事实（跨会话记住的，可能过时；与用户当前说法冲突时以用户为准）：'
  const lines: string[] = [header]
  for (const entry of entries) {
    const line = `- ${entry.key} = ${entry.value}`
    if (lines.join('\n').length + line.length + 1 > maxChars) {
      lines.push('- …（还有更多事实，需要时用 fact_context 查询）')
      break
    }
    lines.push(line)
  }
  return lines.join('\n').slice(0, maxChars)
}

/**
 * 取出全部事实用于相关性打分。
 *
 * 优先 `context('')`（语义就是「列出全部」）；只实现了 `search` 的替身退回
 * `search('', …)`，这样回灌在两种服务形状下都能工作。
 */
function listAllFacts(service: MemoryService): MemoryEntry[] {
  if (typeof service.context === 'function') return service.context('', { limit: 500 })
  return service.search('', { limit: 500 })
}

/** 构造注入消息（user 角色、插件来源、snapshot 形态）。 */
export function makeRecallMessage(entries: readonly MemoryEntry[], maxChars: number): {
  id: string
  role: 'user'
  content: Array<{ type: 'text'; text: string }>
  source: { kind: string; plugin: string; form: string; sections: Array<{ name: string; text: string }> }
} {
  const text = renderRecallCard(entries, maxChars)
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: 'plugin',
      plugin: 'dsh-thesis',
      form: 'snapshot',
      sections: [{ name: '已确认事实', text }],
    },
  }
}

/** 记忆指纹：用于「记忆没变就不再注入」。 */
function fingerprint(entries: readonly MemoryEntry[]): string {
  let latest = 0
  for (const entry of entries) latest = Math.max(latest, entry.updatedAt)
  return `${entries.length}:${latest}`
}

/**
 * 安装跨会话事实回灌监听。
 *
 * 需要一个已注册的 `ctx.memory`（由 `registerFacts` 提供）；没有则静默不装。
 */
export function installFactRecall(ctx: Context, options: RecallOptions = RECALL_DEFAULTS): void {
  const lastInjected = new WeakMap<object, string>()

  ctx.on('agent/pre-step', async (payload, next) => {
    const downstream = await next()
    if (downstream.kind !== 'enter') return downstream
    try {
      const messages = payload.messages as Array<{ source?: { kind?: string }; content?: unknown }> | undefined
      const last = messages?.[messages.length - 1]
      if (last === undefined || last.source?.kind !== 'user') return downstream

      const text = textOfBlocks((last.content ?? []) as Array<{ type: string; text?: string }>)
      if (text.trim().length < 8 || text.trim().startsWith('/')) return downstream

      const service = ctx.get('memory') as MemoryService | undefined
      if (service === undefined || typeof service.search !== 'function') return downstream

      // 取全量事实用于相关性打分。注意不能用 `search('')`：空 query 会抛错
      // （避免"匹配一切"的静默语义）。优先用 `context('')`——它的语义就是"列出全部"；
      // 只有实现了 search 的替身才退回 search（此时按老语义传空 query）。
      const entries = listAllFacts(service)
      if (entries.length === 0) return downstream

      const keywords = keywordsOf(text, options.minKeywordLength)
      if (keywords.length === 0) return downstream
      const relevant = selectRelevant(entries, keywords, options.maxEntries)
      if (relevant.length === 0) return downstream

      const agent = (payload as { agent?: object }).agent
      if (agent !== undefined) {
        const mark = fingerprint(entries)
        if (lastInjected.get(agent) === mark) return downstream
        lastInjected.set(agent, mark)
      }

      const injected = makeRecallMessage(relevant, options.maxChars)
      return { kind: 'enter', messages: [...(downstream.messages as unknown[]), injected] }
    } catch {
      // 记忆回灌是增益功能：任何异常都不允许影响对话本身。
      return downstream
    }
  })
}
