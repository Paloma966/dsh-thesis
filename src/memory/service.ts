/**
 * 跨会话事实：SQLite provider 与它的类型契约。
 *
 * **刻意不继承 cordis 的 `Service` 基类**：provider 是个普通类，由
 * `registerFacts` 通过 `ctx.provide('memory', service)` 注册。这样做的收益：
 * 整个事实库可以在**没有宿主运行时**的环境里被构造与验证——装配测试
 * 用一个假的 ctx 就能跑通 `apply()`，而不必把 cordis 拖进测试依赖。
 *
 * 面向学生的说法是「记住你的学校和导师要求，换个会话不用重讲」；
 * `memory` 只是它在宿主里的服务名，不是学生要调用的工具。
 *
 * 业务语义在 {@link MemoryStore}（纯 SQLite）；本文件只做参数校验边界。
 *
 * @module dsh-thesis/memory/service
 */

import { MemoryStore } from './store.ts'
import type {
  MemoryContextOptions,
  MemoryEntry,
  MemoryInput,
  MemorySearchOptions,
  RememberResult,
} from './types.ts'

export type {
  MemoryContextOptions,
  MemoryEntry,
  MemoryInput,
  MemorySearchOptions,
  MemoryType,
  RememberResult,
} from './types.ts'

/** 记忆能力的对外契约（`ctx.get('memory')` 拿到的就是这个形状）。 */
export interface MemoryService {
  /** 创建或原地更新一条记忆。 */
  remember(entry: MemoryInput): RememberResult
  /** 对 key 与 value 做大小写不敏感子串检索。 */
  search(query: string, options?: MemorySearchOptions): MemoryEntry[]
  /** 列出某个命名空间/前缀下的全部条目。 */
  context(topic: string, options?: MemoryContextOptions): MemoryEntry[]
}

/** 唯一的 provider：一个 SQLite 文件（或 `:memory:`）。 */
export class SqliteMemoryService implements MemoryService {
  private readonly store: MemoryStore

  /**
   * @param dbPath - SQLite 文件路径或 `:memory:`；父目录缺失时自动创建。
   */
  constructor(dbPath: string) {
    this.store = new MemoryStore(dbPath)
  }

  /** 关闭数据库（插件卸载时由 `ctx.effect` 调用）。 */
  close(): void {
    this.store.close()
  }

  remember(entry: MemoryInput): RememberResult {
    return this.store.remember(entry)
  }

  search(query: string, options: MemorySearchOptions = {}): MemoryEntry[] {
    return this.store.search(query, options)
  }

  context(topic: string, options: MemoryContextOptions = {}): MemoryEntry[] {
    return this.store.context(topic, options)
  }
}
