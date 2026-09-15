/**
 * 本插件需要的那一小片宿主文件系统接缝。
 *
 * 刻意**不**从 `@deepseek-ai/dsh-fs` 导入：已发布的 rc.1 依赖树引用了未发布的包，
 * 因此外部 bundle 不能安装 dsh 包。宿主真实的 `ctx.fs` 在运行期满足这个结构化
 * 接口；引擎只通过这份声明的契约与它对话。
 *
 * @module dsh-thesis/codewalk
 */

/** 不透明的已解析文件句柄；只有 `displayPath` 可以对外展示。 */
export interface LearningFsTarget {
  readonly targetKey: unknown
  readonly displayPath: string
}

/** `stat` 返回的元信息。 */
export interface LearningFsInfo {
  readonly version: unknown
  readonly type: string
}

/** 受保护的写入意图：仅当目标不存在时创建。 */
export interface CreateIfAbsentIntent {
  readonly createIfAbsent: true
}

/** 引擎传给 `writeText` 的写入意图联合。 */
export type LearningWriteIntent = CreateIfAbsentIntent

/** 引擎使用的文件系统表面；由宿主 `ctx.fs` 满足。 */
export interface StateFileSystem {
  resolve(path: string, opts?: { cwd?: string }): Promise<LearningFsTarget>
  stat(target: LearningFsTarget, signal?: AbortSignal): Promise<LearningFsInfo | undefined>
  readText(target: LearningFsTarget, signal?: AbortSignal): Promise<string>
  writeText(target: LearningFsTarget, content: string, expected?: LearningWriteIntent, signal?: AbortSignal): Promise<void>
}
