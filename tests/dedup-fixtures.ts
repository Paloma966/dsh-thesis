/**
 * 降重模块测试用的内存文件系统：只实现插件实际用到的 FileSystem 表面。
 *
 * 行为约定（与仓库内既有 fake-fs 一致）：
 * - `readText` 文件缺失即抛错（带 code=ENOENT）；
 * - `listDir` 目录缺失即抛错，存在返回直接子项（目录项 isDirectory=true）；
 * - `writeText` 自动「创建」父目录（内存实现天然如此）。
 */

import * as nodePath from 'node:path'
import type { FileSystem, FsDirEntry, FsTarget } from '@deepseek-ai/dsh-fs'

export class FakeFs implements FileSystem {
  private readonly files = new Map<string, string>()

  private key(p: string): string {
    return nodePath.normalize(p)
  }

  get size(): number {
    return this.files.size
  }

  peek(p: string): string | undefined {
    return this.files.get(this.key(p))
  }

  /** 测试便捷入口：直接写入一个文件（同时隐含创建父目录）。 */
  put(p: string, content: string): void {
    this.files.set(this.key(p), content)
  }

  /** 测试便捷入口：列出所有已写入的文件路径。 */
  paths(): string[] {
    return [...this.files.keys()].sort()
  }

  async resolve(path: string, _opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    return { displayPath: path }
  }

  async readText(target: FsTarget, _signal?: AbortSignal): Promise<string> {
    const content = this.files.get(this.key(target.displayPath))
    if (content === undefined) {
      const err = new Error(`ENOENT: ${target.displayPath}`) as Error & { code?: string }
      err.code = 'ENOENT'
      throw err
    }
    return content
  }

  async writeText(target: FsTarget, content: string): Promise<{ version?: unknown }> {
    this.files.set(this.key(target.displayPath), content)
    return { version: 1 }
  }

  async listDir(target: FsTarget, _signal?: AbortSignal): Promise<FsDirEntry[]> {
    const dir = this.key(target.displayPath)
    const entries: FsDirEntry[] = []
    const seen = new Set<string>()
    let found = false
    for (const key of this.files.keys()) {
      if (key === dir) continue
      if (!key.startsWith(dir + nodePath.sep)) continue
      found = true
      const rest = key.slice(dir.length + 1)
      const name = rest.split(nodePath.sep)[0]!
      if (seen.has(name)) continue
      seen.add(name)
      entries.push({ name, isDirectory: rest.includes(nodePath.sep) })
    }
    if (!found && !this.files.has(dir)) {
      const err = new Error(`ENOENT: ${dir}`) as Error & { code?: string }
      err.code = 'ENOENT'
      throw err
    }
    return entries
  }

  async stat(_target: FsTarget, _signal?: AbortSignal): Promise<never> {
    throw new Error('FakeFs.stat not implemented')
  }
}

/** 测试用固定时间：保证报告时间戳可复现。 */
export const FIXED_NOW = new Date('2026-03-01T00:00:00.000Z')

/** 构造一个最小可用的论文工作区（台账 + 章节 + 语料）。 */
export function makeWorkspace(files: Record<string, string>): FakeFs {
  const fs = new FakeFs()
  fs.put('C:/thesis/00-管理/进度台账.md', '# 进度台账\n\n（测试用）\n')
  for (const [path, content] of Object.entries(files)) fs.put(`C:/thesis/${path}`, content)
  return fs
}

export const WORKSPACE_CWD = 'C:/thesis/06-论文'
