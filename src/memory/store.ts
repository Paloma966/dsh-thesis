/**
 * 记忆存储：纯 SQLite 实现，**零 cordis 依赖**（可独立单测）。
 *
 * 与 `service.ts` 的分工遵循本仓库的通用约定：业务逻辑在 store 里，
 * 宿主服务外壳（`ctx.memory`）只是它的适配器。这样记忆的语义
 * （原地更新保留 createdAt、子串检索、前缀上下文）能在没有宿主
 * 运行时的环境里被直接验证。
 *
 * @module dsh-thesis/memory/store
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type {
  MemoryContextOptions,
  MemoryEntry,
  MemoryInput,
  MemorySearchOptions,
  RememberResult,
} from './types.ts'

/** 一行存储记录（列名即数据库列名）。 */
interface MemoryRow {
  key: string
  value: string
  type: string
  source: string
  confidence: number
  created_at: number
  updated_at: number
}

/** 记忆 key 规范化：去空白后不得为空。 */
export function normalizeKey(key: string): string {
  const trimmed = key.trim()
  if (trimmed.length === 0) {
    throw new Error('memory: key must be a non-empty string')
  }
  return trimmed
}

/** 单次查询返回条数的上限：防止一次把整张表倒进上下文。 */
export const MAX_LIMIT = 500

/** 把调用方给的 limit 夹到 `[1, MAX_LIMIT]`；缺省 50（而不是"不限制"）。 */
export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return 50
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)))
}

/**
 * SQLite 记忆存储。`:memory:` 打开进程内临时库（测试用）。
 *
 * 语义约定（与 `MemoryService` 的抽象契约一致）：
 * - `remember`：新 key 插入，已有 key 原地更新且保留 `createdAt`；
 * - `search`：对 key 与 value 做大小写不敏感子串匹配，按 key 排序；
 * - `context`：返回 key 等于 topic 或以 `topic.` 开头的全部条目。
 */
export class MemoryStore {
  private readonly db: DatabaseSync

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      const target = resolve(dbPath)
      mkdirSync(dirname(target), { recursive: true })
      dbPath = target
    }
    this.db = new DatabaseSync(dbPath)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        type       TEXT NOT NULL,
        source     TEXT NOT NULL,
        confidence REAL NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT
    `)
  }

  /** 关闭数据库。幂等（插件卸载与测试清理都会调用）。 */
  close(): void {
    this.db.close()
  }

  remember(entry: MemoryInput): RememberResult {
    const key = normalizeKey(entry.key)
    const now = Date.now()
    const existing = this.getRow(key)
    if (existing === undefined) {
      this.db.prepare(
        'INSERT INTO memories (key, value, type, source, confidence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(key, entry.value, entry.type, entry.source, entry.confidence, now, now)
      return { action: 'created', key, value: entry.value }
    }
    this.db.prepare(
      'UPDATE memories SET value = ?, type = ?, source = ?, confidence = ?, updated_at = ? WHERE key = ?',
    ).run(entry.value, entry.type, entry.source, entry.confidence, now, key)
    return { action: 'updated', key, value: entry.value }
  }

  /**
   * 检索事实。
   *
   * `query` 为空串时**不当作"匹配一切"**：必须同时给出 `namespace`，否则抛错——
   * 否则 `search('')` 会静默返回整张表的前 N 条，调用方以为自己在做检索。
   * 回灌路径要全量取用时请显式给 `namespace`（它内部按命名空间取）。
   *
   * `limit` 一律夹到 `[1, 500]`：负数或 0 以前会**完全绕开 SQL 的 LIMIT**，返回整张表。
   */
  search(query: string, options: MemorySearchOptions = {}): MemoryEntry[] {
    if (query === '' && options.namespace === undefined) {
      throw new Error('fact_search 需要一个非空 query，或一个 namespace（只给 namespace 表示「列出该命名空间下的全部事实」）。')
    }
    const clauses: string[] = []
    const args: (string | number)[] = []
    if (options.namespace !== undefined) {
      clauses.push('key LIKE ?')
      args.push(options.namespace + '.%')
    }
    if (query !== '') {
      clauses.push('(key LIKE ? OR value LIKE ?)')
      const pattern = `%${query}%`
      args.push(pattern, pattern)
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : ''
    args.push(clampLimit(options.limit))
    return this.rows(`SELECT key, value, type, source, confidence, created_at, updated_at FROM memories${where} ORDER BY key LIMIT ?`, args)
  }

  context(topic: string, options: MemoryContextOptions = {}): MemoryEntry[] {
    const args: (string | number)[] = [topic, topic + '.%', clampLimit(options.limit)]
    return this.rows(
      'SELECT key, value, type, source, confidence, created_at, updated_at FROM memories'
      + ' WHERE key = ? OR key LIKE ? ORDER BY key LIMIT ?',
      args,
    )
  }

  private getRow(key: string): MemoryRow | undefined {
    return this.db.prepare(
      'SELECT key, value, type, source, confidence, created_at, updated_at FROM memories WHERE key = ?',
    ).get(key) as unknown as MemoryRow | undefined
  }

  private rows(sql: string, args: (string | number)[]): MemoryEntry[] {
    const rows = this.db.prepare(sql).all(...args) as unknown as MemoryRow[]
    return rows.map(row => ({
      key: row.key,
      value: row.value,
      type: row.type as MemoryEntry['type'],
      source: row.source,
      confidence: row.confidence,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
  }
}
