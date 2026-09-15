/**
 * 跨会话事实的纯类型：service 与面向模型的工具共用这套词汇。
 *
 * @module dsh-thesis/memory/types
 */

/** 分类一条事实：fact（事实）/ preference（偏好）/ entity（实体）/ relation（关系）。 */
export type MemoryType = 'fact' | 'preference' | 'entity' | 'relation'

/** 一次写入请求（交给 {@link MemoryService.remember}）。 */
export interface MemoryInput {
  /** 事实 key，约定三段式 `namespace.entity.attribute`。 */
  key: string
  /** 要记住的值。 */
  value: string
  /** 分类。 */
  type: MemoryType
  /** 来源标注，如文件路径或 `manual`。 */
  source: string
  /** 置信度，取值 `0..1`。 */
  confidence: number
}

/** 一条已存事实（读取时返回的形态）。 */
export interface MemoryEntry {
  key: string
  value: string
  type: MemoryType
  source: string
  confidence: number
  /** 首次写入的时间戳（epoch 毫秒）。 */
  createdAt: number
  /** 最近一次写入的时间戳（epoch 毫秒）。 */
  updatedAt: number
}

/** 一次成功写入的结果。 */
export interface RememberResult {
  /** 新 key 为 `created`，已存在的 key 为 `updated`。 */
  action: 'created' | 'updated'
  key: string
  value: string
}

/** {@link MemoryService.search} 的收窄选项。 */
export interface MemorySearchOptions {
  /** 只考虑以该命名空间前缀开头的 key（`namespace.`）。 */
  namespace?: string
  /**
   * 最多返回条数。**缺省 50，一律夹到 `[1, 500]`**：
   * 传给 SQL 的 LIMIT 不能省（否则一次检索会把整张表倒进上下文），
   * 负数或 0 也不再被解释为「不限制」。
   */
  limit?: number
}

/** {@link MemoryService.context} 的收窄选项。 */
export interface MemoryContextOptions {
  /** 最多返回条数；与 `search` 同一套夹取规则。 */
  limit?: number
}
