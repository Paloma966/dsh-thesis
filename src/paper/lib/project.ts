/**
 * 论文工作区根目录定位：从当前会话 cwd 向上寻找 `00-管理/进度台账.md`，
 * 或使用配置显式指定的工作区根。
 *
 * **为什么向上探测而不是记住路径**：装配发生在进程启动时，那时还没有会话，
 * 也就没有 cwd。向上探测让「在论文仓库里任意子目录操作」都能正确定位根。
 *
 * @module dsh-thesis/paper/lib/project
 */

import * as nodePath from 'node:path'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { isAbortError, isMissingError } from '../../shared/fs-errors.ts'

export const LEDGER_REL = '00-管理/进度台账.md'
export const DECISION_REL = '00-管理/决定日志.md'

/** 向上最多探测的层级数（防止在文件系统根上无意义循环）。 */
const MAX_UP = 8

/**
 * 配置显式指定的论文工作区根。
 *
 * 语义是**部署级**的（一个插件装载对应一个论文工作区），因此用模块级持有：
 * 装配时由 {@link setWorkspaceRoot} 写入，工具执行时读取。这样做而不把
 * workspace 参数穿透到十几个调用点，是因为宿主在进程启动时装配、之后才执行
 * 工具，时序上不存在竞态；单用户单工作区是插件的目标场景。
 */
let configuredRoot: string | undefined

/** 装配时由 `src/index.ts` 调用；传 `undefined` 表示恢复「向上探测」。 */
export function setWorkspaceRoot(root: string | undefined): void {
  configuredRoot = root === '' ? undefined : root
}

/** 当前生效的显式工作区根（测试与诊断用）。 */
export function currentWorkspaceRoot(): string | undefined {
  return configuredRoot
}

/** 工作区未找到时的统一错误文案（工具层直接抛）。 */
export function workspaceNotFoundError(cwd: string | undefined): Error {
  const where = cwd === undefined || cwd === '' ? '（本次调用没有会话工作目录）' : `（自 ${cwd} 向上查找 ${LEDGER_REL} 失败）`
  return new Error(
    `未找到论文工作区${where}。请先用 thesis_init 创建工作区后在论文目录内操作；`
    + '若工作区在别处，可在插件配置里用 `workspace` 指定它的绝对路径。',
  )
}

/**
 * 找到论文工作区根；确实找不到时返回 null。
 *
 * 三种情况严格区分：
 * - **显式配置了 workspace**：只认它。台账不存在或读不出来 → 抛错（配置写错了要立刻知道，
 *   绝不能悄悄退回到 cwd 探测，否则工具会写到别的目录去）。
 * - **向上探测**：某层没有台账 → 继续往上；读失败（权限/IO）→ 抛错，
 *   因为「读不出来」不等于「不存在」，静默跳过会让用户以为工作区不存在。
 * - **走到头**：返回 null（调用方给可读错误）。
 */
export async function findThesisRoot(fs: FileSystem, cwd: string | undefined, signal?: AbortSignal): Promise<string | null> {
  if (configuredRoot !== undefined) {
    const root = nodePath.resolve(configuredRoot)
    const ledger = nodePath.join(root, LEDGER_REL)
    try {
      await fs.readText(await fs.resolve(ledger, { signal }), signal)
      return root
    } catch (error) {
      if (isAbortError(error)) throw error
      if (isMissingError(error)) {
        throw new Error(
          `配置的 workspace 里没有 ${LEDGER_REL}：${root}。`
          + '该路径不是 dsh-thesis 论文工作区（或工作区尚未创建）；请修正配置或先用 thesis_init 建库。',
        )
      }
      throw new Error(
        `配置的 workspace 里的 ${LEDGER_REL} 存在但读不出来：${ledger}`
        + `（${error instanceof Error ? error.message : String(error)}）。请检查文件权限后重试。`,
      )
    }
  }

  if (cwd === undefined || cwd === '') return null
  let dir = nodePath.resolve(cwd)
  for (let i = 0; i <= MAX_UP; i += 1) {
    try {
      await fs.readText(await fs.resolve(nodePath.join(dir, LEDGER_REL), { signal }), signal)
      return dir
    } catch (error) {
      // 取消必须原样抛出：否则用户按了停止，探测还会继续往上走 8 层。
      if (isAbortError(error)) throw error
      if (!isMissingError(error)) {
        throw new Error(
          `读取 ${nodePath.join(dir, LEDGER_REL)} 失败`
          + `（${error instanceof Error ? error.message : String(error)}）。`
          + '这不是「工作区不存在」，而是读取本身出错；为避免写错目录，已停止本次操作。',
        )
      }
      // 该层确实没有台账，继续向上。
    }
    const parent = nodePath.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}
