/**
 * 跨会话事实的装配层：把 SQLite 事实库挂到 `ctx.memory`
 * 并注册三个模型工具（`fact_search` / `fact_remember` / `fact_context`）。
 *
 * 落点：`$DSH_HOME/dsh-thesis-memory.db`（可用 `memoryPath` 覆盖）。**刻意用一个
 * 全局库**而不是每篇论文一个库：装配发生在进程启动时、拿不到会话 cwd；而事实
 * 里跨课题复用的内容（写作风格偏好、导师沟通习惯、学校通用规范）本来就应该
 * 跨项目活着。课题专属内容用 key 前缀隔离：
 * `thesis.<课题 slug>.<实体>.<属性>`。
 *
 * **面向学生的说法**：这是「记住你的学校和导师要求，换个会话不用重讲」的能力，
 * 不是「记忆系统」。学生不需要知道它叫 memory。
 *
 * @module dsh-thesis/memory
 */

import type { Context } from '@deepseek-ai/cordis'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { installFactRecall as installRecall } from './recall.ts'
import type { RecallOptions } from './recall.ts'
import { SqliteMemoryService, type MemoryService } from './service.ts'
import { memoryTools } from './tools.ts'

/**
 * 默认库位置：`$DSH_HOME/dsh-thesis-memory.db`，否则 `~/.dsh-thesis-memory.db`。
 *
 * 只有一个位置，没有回退：本插件的包名从未以其它名字发布过，因此不存在
 * 「数据躺在旧文件里、新文件是空的」这种需要兼容的历史包袱。
 * 建这种回退只会留下一条永远不成立的分支。
 */
export function defaultMemoryPath(): string {
  const home = process.env.DSH_HOME?.trim()
  const dir = home !== undefined && home !== '' ? home : homedir()
  return join(dir, 'dsh-thesis-memory.db')
}

export interface FactRegistration {
  readonly service: MemoryService
  readonly path: string
}

/**
 * 装配跨会话事实：provider + 三个模型工具，注册为 `ctx.memory`。
 * Disposal 关闭数据库。
 */
export function registerFacts(ctx: Context, configured?: string): FactRegistration {
  const path = configured === ':memory:' || configured === undefined || configured.trim() === ''
    ? (configured ?? defaultMemoryPath())
    : resolve(configured)
  const service = new SqliteMemoryService(path)
  ctx.provide('memory', service)
  ctx.effect(() => () => service.close(), 'dsh-thesis.memory.closeDatabase')
  for (const tool of memoryTools(service)) {
    ctx.tools.register(tool)
  }
  return { service, path }
}

/** 装配「相关时把已确认事实放回上下文」。 */
export function installFactRecall(ctx: Context, options: RecallOptions): void {
  installRecall(ctx, options)
}
