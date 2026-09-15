/**
 * 面向模型的跨会话事实工具定义：`fact_search` / `fact_remember` / `fact_context`，
 * 三个工具共用同一个 {@link MemoryService}。
 *
 * 命名空间 `fact_*` 的含义：**跨会话仍然成立的稳定事实**——学校规范、导师要求、
 * 你的写作偏好。它与 `thesis_*`（操作论文工作区里的东西）并列。
 * 进度、临时任务、一次性的实验数字不属于这里（它们在进度台账与实验记录里）。
 *
 * @module dsh-thesis/memory/tools
 */

import { definePaperTool } from '../shared/index.ts'
import type { MemoryService } from './service.ts'
import type { MemoryType } from './types.ts'

const MEMORY_TYPES = ['fact', 'preference', 'entity', 'relation'] as const

/** A search result row, as returned in the canonical tool value. */
interface SearchRow {
  key: string
  value: string
  source: string
  confidence: number
}

/** A context fact row, as returned in the canonical tool value. */
interface FactRow {
  key: string
  value: string
  confidence: number
}

/** Resolve model-omitted fields into a complete write request. */
function resolveRememberInput(raw: {
  key: string
  value: string
  type?: string
  source?: string
  confidence?: number
}): { key: string; value: string; type: MemoryType; source: string; confidence: number } {
  const key = raw.key.trim()
  if (key.length === 0) {
    throw new Error('fact_remember: `key` must be a non-empty string')
  }
  if (raw.value.trim().length === 0) {
    throw new Error('fact_remember: `value` must be a non-empty string')
  }
  const type = (raw.type ?? 'fact') as MemoryType
  const confidence = raw.confidence ?? 1
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error(`fact_remember: confidence must be in 0..1, got ${JSON.stringify(confidence)}`)
  }
  return {
    key,
    value: raw.value,
    type,
    source: raw.source?.trim() || 'manual',
    confidence,
  }
}

function renderSearchResults(results: SearchRow[]): string {
  if (results.length === 0) return '没有找到相关记忆。'
  return results.map(row => `${row.key} = ${row.value}`).join('\n')
}

/** Build the inline natural-language projection of a context listing. */
function renderContext(facts: FactRow[]): string {
  if (facts.length === 0) return '这个主题下还没有记忆。'
  const byNamespace = new Map<string, string[]>()
  for (const fact of facts) {
    const dot = fact.key.indexOf('.')
    const namespace = dot === -1 ? fact.key : fact.key.slice(0, dot)
    const rest = dot === -1 ? fact.key : fact.key.slice(dot + 1)
    const rows = byNamespace.get(namespace) ?? []
    rows.push(`${rest}=${fact.value}`)
    byNamespace.set(namespace, rows)
  }
  let out = ''
  for (const [namespace, rows] of byNamespace) {
    out += (out.length === 0 ? '' : '。') + `关于 ${namespace}: ${rows.join(', ')}`
  }
  return `${out}。`
}

/**
 * 三个面向模型的跨会话事实工具。
 *
 * 命名空间 `fact_*` 的含义：**跨会话仍然成立的稳定事实**——学校规范、导师要求、
 * 你的写作偏好。它与 `thesis_*`（操作论文工作区里的东西）是并列的两类。
 * 进度、临时任务、一次性的实验数字不属于这里（它们在进度台账与实验记录里）。
 */
export function memoryTools(service: MemoryService): unknown[] {
  return [
    definePaperTool({
      name: 'fact_search',
      description: '在跨会话事实库里检索：对 key 与 value 做大小写不敏感的子串匹配（可选限定命名空间、限制条数）。'
        + '用于确认「上次记下的学校规范/导师要求/写作偏好还在不在」，以及回答用户「我之前说过什么」。',
      parameters: {
        query: { type: 'string', required: true, description: '要匹配的子串（同时匹配 key 与 value）' },
        namespace: { type: 'string', description: '可选命名空间；只考虑该前缀下的 key（如 thesis 或 thesis.face-attendance）' },
        limit: { type: 'integer', description: '返回条数上限，默认 10' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            results: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  key: { type: 'string', required: true },
                  value: { type: 'string', required: true },
                  source: { type: 'string', required: true },
                  confidence: { type: 'number', required: true },
                },
              },
            },
          },
        },
        render: (_args, value) => [{ type: 'text', text: renderSearchResults(value.results) }],
      },
      async execute(args) {
        const entries = service.search(args.query, {
          ...args.namespace !== undefined ? { namespace: args.namespace } : {},
          limit: args.limit ?? 10,
        })
        return {
          results: entries.map(entry => ({
            key: entry.key,
            value: entry.value,
            source: entry.source,
            confidence: entry.confidence,
          })),
        }
      },
    }),
    definePaperTool({
      name: 'fact_remember',
      description: '写入或更新一条跨会话事实（key 已存在则原地更新，保留原始创建时间）。'
        + '只记**跨会话仍然成立**的事实：用户偏好（user.*）、学校通用规范（school.*）、课题稳定事实（thesis.<课题>.*）。'
        + '不要把进度、临时任务或一次性实验数字写进来——那些在进度台账与实验记录里。',
      parameters: {
        key: { type: 'string', required: true, description: '记忆 key，三段式 `namespace.entity.attribute`，如 school.dedup.system' },
        value: { type: 'string', required: true, description: '要记住的值' },
        type: {
          type: 'string',
          enum: [...MEMORY_TYPES],
          description: '分类：fact（事实）/ preference（偏好）/ entity（实体）/ relation（关系），默认 fact',
        },
        source: { type: 'string', description: '来源标注，默认 manual；如 intake（追问确认）、decision（决定日志）' },
        confidence: { type: 'number', description: '置信度 0..1，默认 1' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: { type: 'string', required: true, enum: ['created', 'updated'] },
            key: { type: 'string', required: true },
            value: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: `${value.action === 'created' ? '已写入' : '已更新'}记忆 ${value.key} = ${value.value}`,
        }],
      },
      async execute(args) {
        const input = resolveRememberInput(args)
        return service.remember(input)
      },
    }),
    definePaperTool({
      name: 'fact_context',
      description: '取出某个命名空间/前缀下的全部事实作为上下文，同时给出自然语言投影与 key-value 列表。'
        + '开新会话时用它把「这个课题/这所学校已知的稳定事实」一次性拉回来。',
      parameters: {
        topic: { type: 'string', required: true, description: '命名空间或 key 前缀，如 thesis.face-attendance' },
        limit: { type: 'integer', description: '返回条数上限，默认不限' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            context: { type: 'string', required: true },
            facts: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  key: { type: 'string', required: true },
                  value: { type: 'string', required: true },
                  confidence: { type: 'number', required: true },
                },
              },
            },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.context }],
      },
      async execute(args) {
        const entries = service.context(args.topic, {
          ...args.limit !== undefined ? { limit: args.limit } : {},
        })
        const facts = entries.map(entry => ({
          key: entry.key,
          value: entry.value,
          confidence: entry.confidence,
        }))
        return { context: renderContext(facts), facts }
      },
    }),
  ]
}
