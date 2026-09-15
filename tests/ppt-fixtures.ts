/**
 * `tests/ppt-*.test.ts` 共用的测试替身与素材样例。
 *
 * 参照只读文件 `dsh-thesis/plugin/tests/fake-fs.ts` 的假文件系统实现（拷入本仓库，
 * 保证 ppt 测试不依赖其它目录的并发改动）：readText 文件缺失即抛错、listDir
 * 目录缺失即抛错、writeText 自动记录内容（不需要显式建目录）。
 *
 * @module dsh-thesis/ppt-tests
 */

import * as nodePath from 'node:path'
import type { FileSystem, FsDirEntry, FsTarget, FsInfo } from '@deepseek-ai/dsh-fs'

/** 测试用内存文件系统。 */
export class FakeFs implements FileSystem {
  private readonly files = new Map<string, string>()

  private key(p: string): string {
    return nodePath.normalize(p)
  }

  get size(): number {
    return this.files.size
  }

  /** 读一个已存在的文件内容（不存在返回 undefined）。 */
  peek(p: string): string | undefined {
    return this.files.get(this.key(p))
  }

  has(p: string): boolean {
    return this.files.has(this.key(p))
  }

  /** 列出全部文件路径（测试断言用）。 */
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

  async writeText(target: FsTarget, content: string, expected?: unknown, _signal?: AbortSignal): Promise<{ version?: unknown }> {
    void expected
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
      if (!seen.has(name)) {
        seen.add(name)
        entries.push({ name, isDirectory: false })
      }
    }
    if (!found && !this.files.has(dir)) {
      const err = new Error(`ENOENT: ${dir}`) as Error & { code?: string }
      err.code = 'ENOENT'
      throw err
    }
    return entries
  }

  async stat(target: FsTarget, _signal?: AbortSignal): Promise<FsInfo | undefined> {
    if (!this.files.has(this.key(target.displayPath))) return undefined
    return { isDirectory: false, size: 1 }
  }
}

/** 测试用固定时间（保证备份文件名可断言）。 */
export const FAKE_NOW = new Date('2026-09-12T10:20:30')

/** 论文仓库根的固定假路径（FakeFs 会 normalize 它）。 */
export const ROOT = nodePath.join('C:', 'repo', 'thesis')

export const PPT_REL = '07-答辩/PPT.md'
export const PPTX_REL = '07-答辩/PPT.pptx'
export const NOTES_REL = '07-答辩/PPT转换说明.md'
export const MATERIALS_REL = '07-答辩/答辩素材.md'

/** 一份贴近真实的《答辩素材》样例（结构由 thesis_defense 生成）。 */
export const SAMPLE_MATERIALS = `# 答辩素材

> 由 thesis_defense 自动提取；时间：2026-05-01T08:00:00.000Z
> 这是答辩讲稿的事实底座——PPT 每页内容、问答答案都以这里的材料为准。

## 课题

基于知识图谱的校园二手书交易平台设计与实现

## 章节概览

### 第 1 章 绪论（2480 字，引用 18 处）

- 1.1 研究背景与意义
- 1.2 国内外研究现状
- 1.3 本文主要工作
- 1.4 论文组织结构

### 第 4 章 系统设计（3120 字，引用 6 处）

- 4.1 总体架构设计
- 4.2 模块设计
- 4.3 数据库设计
- 4.4 接口设计

### 第 5 章 系统实现（3560 字，引用 4 处）

- 5.1 开发环境
- 5.2 书籍检索模块实现
- 5.3 推荐模块实现
- 5.4 订单模块实现

### 第 6 章 系统测试（2240 字，引用 2 处）

- 6.1 测试环境
- 6.2 测试用例设计
- 6.3 测试结果与分析

### 第 7 章 总结与展望（860 字，引用 0 处）

- 7.1 工作总结
- 7.2 不足与展望

## 技术选型（答辩必问"为什么"）

- 后端框架：Spring Boot（理由：生态成熟、课程已学；备选：Flask；弃用备选的原因：异步与权限生态弱）
- 数据库：MySQL（理由：事务可靠、团队熟悉；备选：MongoDB）
- 前端：Vue 3（理由：组件化与学习成本平衡；备选：React）

## 关键决定（决定日志）

- 2026-01-10 采用知识图谱做书籍关联推荐
- 2026-02-02 放弃 Elasticsearch，改用 MySQL 全文索引
- 2026-03-05 订单流程引入状态机，避免脏状态

## 测试与数据

- 测试用例：24 个（05-实验测试/测试计划.md）
- 结果文件：检索性能-2026-04-20.csv、推荐准确率.csv、订单并发测试.csv

## 工作量（git）

- 提交：137 次
- 跨度：2026-01-05 ~ 2026-04-28

## 文献

refs.bib 收录 26 条（全部真实检索，审计记录见 02-文献/检索记录.md）
`

/** 真实代码目录样例（证据锚点校验用）。 */
export const SAMPLE_CODE_FILES: Record<string, string> = {
  '04-实现/src/main/java/edu/book/BookSearchService.java': '// 意图：书籍检索（全文索引 + 图谱关联）\nclass BookSearchService {}\n',
  '04-实现/README.md': '# 实现说明\n\n- 书籍检索：MySQL 全文索引\n- 推荐：知识图谱二跳关联\n',
}

/** 实验测试结果样例。 */
export const SAMPLE_RESULT_FILES: Record<string, string> = {
  '05-实验测试/结果/检索性能-2026-04-20.csv': 'query,ms\n"二手教材",38\n"考研数学",52\n',
  '05-实验测试/结果/推荐准确率.csv': 'topK,precision\n5,0.62\n10,0.55\n',
  '05-实验测试/结果/订单并发测试.csv': 'threads,tps\n50,412\n100,388\n',
}

/** 进度台账样例（findThesisRoot 的锚点文件）。 */
export const SAMPLE_LEDGER = `# 进度台账

> （节选，仅保留标题字段）

- title: 基于知识图谱的校园二手书交易平台设计与实现
- 当前阶段：9 答辩
`

/** 章节回退样例（素材缺失时用）。 */
export const SAMPLE_CHAPTERS: Record<string, string> = {
  '06-论文/章节/01-绪论.md': `# 第 1 章 绪论

## 1.1 研究背景与意义

校园二手书流转存在信息不对称问题。

## 1.2 国内外研究现状

现有平台缺少书籍内容层面的关联推荐。

## 1.3 本文主要工作

本文实现检索、推荐与订单三个模块。

## 正文

（真实正文内容，仅测试用）
`,
  '06-论文/章节/04-系统设计.md': `# 第 4 章 系统设计

## 4.1 总体架构设计

采用前后端分离的三层架构。

## 4.2 模块设计

检索/推荐/订单三大模块。

## 4.3 数据库设计

书籍、用户、订单三张核心表。

## 4.4 接口设计

RESTful 接口共 18 个。
`,
  '06-论文/章节/05-系统实现.md': `# 第 5 章 系统实现

## 5.1 开发环境

JDK 17 + Spring Boot 3 + MySQL 8。

## 5.2 书籍检索模块实现

基于 MySQL 全文索引实现关键词检索。

## 5.3 推荐模块实现

知识图谱二跳关联生成推荐列表。

## 5.4 订单模块实现

状态机驱动订单流转，避免脏状态。
`,
  '06-论文/章节/06-系统测试.md': `# 第 6 章 系统测试

## 6.1 测试环境

8 核 16G 云服务器，MySQL 8。

## 6.2 测试用例设计

24 个用例，覆盖 FR-1 ~ FR-12。

## 6.3 测试结果与分析

检索平均 38-52 ms，推荐 P@5 为 0.62。
`,
  '06-论文/章节/07-总结与展望.md': `# 第 7 章 总结与展望

## 7.1 工作总结

完成了检索、推荐、订单三大模块。

## 7.2 不足与展望

不足之处：图谱规模有限，冷启动推荐效果一般。
`,
}

/** 把若干 `相对路径 -> 内容` 写进假 fs。 */
export function seedFs(fs: FakeFs, root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = nodePath.join(root, rel)
    void fs.writeText({ displayPath: abs }, content)
  }
}

/** 构造一份"完整"的假论文工作区（素材 + 代码 + 结果 + 台账）。 */
export function seedFullWorkspace(fs: FakeFs, root: string = ROOT): FakeFs {
  seedFs(fs, root, {
    '00-管理/进度台账.md': SAMPLE_LEDGER,
    [MATERIALS_REL]: SAMPLE_MATERIALS,
    ...SAMPLE_CODE_FILES,
    ...SAMPLE_RESULT_FILES,
  })
  return fs
}

/** 构造一份"没有答辩素材"的假工作区（只有进度台账 + 论文章节）。 */
export function seedChaptersOnly(fs: FakeFs, root: string = ROOT): FakeFs {
  seedFs(fs, root, {
    '00-管理/进度台账.md': SAMPLE_LEDGER,
    ...SAMPLE_CHAPTERS,
  })
  return fs
}

/** 计数字符串在文本中的出现次数。 */
export function countOccurrences(text: string, needle: string): number {
  let count = 0
  let index = text.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = text.indexOf(needle, index + needle.length)
  }
  return count
}
