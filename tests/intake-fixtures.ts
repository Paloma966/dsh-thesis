/**
 * `thesis_intake` 的测试夹具：内存文件系统 + 材料清单/台账构造器。
 *
 * 假 fs 的写法（内存 Map + 未命中的
 * 原语一律抛错，避免测试悄悄走到别的路径），并补齐 `listDir` 与 `stat`，
 * 因为 `thesis_intake` 要用它们做原子写与材料探测。
 *
 * 原子写的「改名」在测试里通过 {@link makeIo} 注入内存改名实现，
 * 因此「临时文件 + 改名」的完整路径在假 fs 下也真的走通了。
 *
 * @module dsh-thesis/tests/intake-fixtures
 */

import type { FileSystemLike, IntakeIo } from '../src/intake/state.ts'

/** 内存文件系统：路径 → 内容。 */
export class FakeFs implements FileSystemLike {
  readonly files = new Map<string, string>()
  /** 调用统计：用于断言原子写确实先写临时文件再改名。 */
  readonly writes: string[] = []
  readonly renames: Array<[string, string]> = []

  constructor(init: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(init)) this.files.set(normalize(k), v)
  }

  private key(path: string): string {
    return normalize(path)
  }

  async resolve(path: string, opts?: { cwd?: string }): Promise<{ displayPath: string }> {
    // 假 fs 用 POSIX 风格路径：相对路径直接与 cwd 拼接，不走 node:path（避免
    // Windows 上把 `/thesis` 解释成 `C:\thesis` 导致 findThesisRoot 找不到工作区）。
    // 注意：被测代码会用 node:path.join 拼路径，Windows 上给出的是反斜杠，
    // 所以先统一分隔符再判断绝对性。
    const unified = path.replace(/\\/g, '/')
    if (unified.startsWith('/')) return { displayPath: this.key(unified) }
    if (/^[A-Za-z]:/.test(unified)) return { displayPath: this.key(unified.replace(/^[A-Za-z]:/, '')) }
    const base = (opts?.cwd ?? '/').replace(/\\/g, '/').replace(/\/+$/, '')
    const rel = unified.replace(/^\.\//, '')
    const segs: string[] = []
    for (const part of `${base}/${rel}`.split('/')) {
      if (part === '' || part === '.') continue
      if (part === '..') segs.pop()
      else segs.push(part)
    }
    return { displayPath: this.key(`/${segs.join('/')}`) }
  }

  async readText(target: { displayPath: string }): Promise<string> {
    const content = this.files.get(this.key(target.displayPath))
    if (content === undefined) {
      const error = new Error(`FS_NOT_FOUND: ${target.displayPath}`) as Error & { code: string }
      error.code = 'FS_NOT_FOUND'
      throw error
    }
    return content
  }

  async writeText(target: { displayPath: string }, content: string): Promise<unknown> {
    const key = this.key(target.displayPath)
    this.writes.push(key)
    this.files.set(key, content)
    return { version: 1 }
  }

  async stat(target: { displayPath: string }): Promise<{ isDirectory: boolean; size: number } | undefined> {
    const key = this.key(target.displayPath)
    if (this.files.has(key)) return { isDirectory: false, size: this.files.get(key)!.length }
    const prefix = `${key}/`
    for (const p of this.files.keys()) {
      if (p.startsWith(prefix)) return { isDirectory: true, size: 0 }
    }
    return undefined
  }

  async listDir(target: { displayPath: string }): Promise<Array<{ name: string; isDirectory: boolean }>> {
    const key = this.key(target.displayPath)
    const names = new Map<string, boolean>()
    const prefix = `${key}/`
    for (const p of this.files.keys()) {
      if (!p.startsWith(prefix)) continue
      const rest = p.slice(prefix.length)
      const [head, ...tail] = rest.split('/')
      if (head === undefined || head === '') continue
      names.set(head, tail.length > 0 || names.get(head) === true)
    }
    return [...names.entries()].map(([name, isDirectory]) => ({ name, isDirectory }))
  }

  /** 测试辅助：当前工作区里的全部路径。 */
  paths(): string[] {
    return [...this.files.keys()].sort()
  }
}

/** 路径规范化：统一分隔符、去掉除根之外的尾斜杠、把盘符折成根。 */
export function normalize(path: string): string {
  // 假 fs 是 POSIX 风格：`C:\thesis` / `C:/thesis` / `/thesis` 指向同一个工作区，
  // 这样被测代码用 node:path 拼出来的 Windows 路径也能命中内存里的文件。
  const unified = path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')
  const withRoot = unified.startsWith('/') ? unified : `/${unified}`
  return withRoot.length > 1 ? withRoot.replace(/\/+$/, '') : withRoot
}

/**
 * 造一个 {@link IntakeIo}：读写走假 fs，`rename` 走内存改名（并记录调用）。
 * 不传 `rename` 时走 `writeAtomic` 的兜底路径，用于验证两条路径都能落盘。
 */
export function makeIo(fs: FakeFs, opts: { rename?: boolean } = {}): IntakeIo {
  const io: IntakeIo = {
    async read(path) {
      return fs.files.get(normalize(path))
    },
    async write(path, content) {
      await fs.writeText({ displayPath: normalize(path) }, content)
    },
    async exists(path) {
      return fs.files.has(normalize(path))
    },
    async listDir(path) {
      const entries = await fs.listDir({ displayPath: normalize(path) })
      return entries.map(e => e.name)
    },
    async remove(path) {
      fs.files.delete(normalize(path))
    },
  }
  if (opts.rename !== false) {
    io.rename = async (from, to) => {
      const src = normalize(from)
      const dst = normalize(to)
      const data = fs.files.get(src)
      if (data === undefined) throw new Error(`rename: 源文件不存在 ${src}`)
      fs.renames.push([src, dst])
      fs.files.set(dst, data)
      fs.files.delete(src)
    }
  }
  return io
}

/** 论文工作区根（假 fs 里的绝对路径）。 */
export const ROOT = '/thesis'

/** 造一份台账：`stage` 为 1–9 的数字阶段。 */
export function ledgerMarkdown(stage: number): string {
  return [
    '# 进度台账',
    '',
    '<!-- thesis:state',
    JSON.stringify({ currentStage: stage, updatedAt: '2026-01-01T00:00:00.000Z', gates: {}, tasks: [] }, null, 2),
    '-->',
    '',
    '## 当前状态',
    '',
  ].join('\n')
}

/** 造一份材料清单（表格行含文件名与类型，与 thesis_ingest 的产物形状一致）。 */
export function materialsMarkdown(rows: Array<{ file: string; kind: string; size?: string }>): string {
  const lines = ['# 材料清单', '', '| 文件 | 类型 | 大小 | 说明 |', '|---|---|---|---|']
  for (const r of rows) {
    lines.push(`| ${r.file} | ${r.kind} | ${r.size ?? '12 KB'} | 由 thesis_ingest 摄取 |`)
  }
  lines.push('')
  return lines.join('\n')
}

/** 预置一个论文工作区（台账 + 可选材料清单）。 */
export function workspace(opts: { stage?: number; materials?: string } = {}): FakeFs {
  const fs = new FakeFs()
  fs.files.set(`${ROOT}/00-管理/进度台账.md`, ledgerMarkdown(opts.stage ?? 1))
  if (opts.materials !== undefined) fs.files.set(`${ROOT}/00-管理/材料清单.md`, opts.materials)
  return fs
}

/** 材料清单相对路径（与 `state.ts` 的约定一致）。 */
export const MATERIALS_REL = '00-管理/材料清单.md'

/** 状态文件相对路径。 */
export const STATE_REL = '.paper/intake.json'

/** 规格文件相对路径（测试用配置）。 */
export const SPEC_REL = '00-管理/意图规格.md'
