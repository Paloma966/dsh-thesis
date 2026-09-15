/**
 * 「代码结构」摄取的接线测试（`src/ingest/code.ts` 的纯逻辑由 `ingest-code.test.ts` 覆盖，
 * 这里只验证经 `thesis_ingest` 的目录摄取接线）：
 *
 * - `detectKind` 把源码判为 `code`，但 `.md/.json/.yaml/.html` 与依赖清单仍走 `text`；
 * - 目录摄取后 `00-管理/材料/<目录名>-代码结构.md` 落盘且含语言/声明/技术栈；
 * - `00-管理/材料清单.md` 里有「代码结构」一节；
 * - 超大的依赖清单如实进 `skipped`，不参与技术栈推断；
 * - 单文件 `code` 摄取只返回结构摘要，不返回源码正文。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_MANIFEST_BYTES,
  MANIFEST_REL,
  detectKind,
  extractText,
  runIngest,
} from '../src/ingest/index.ts'
import { FakeFs, FakeIO } from './ingest-fixtures.ts'

const OPTIONS = { maxBytes: 32 * 1024 * 1024, maxChars: 60000 }

function seededFs(): FakeFs {
  const fs = new FakeFs()
  fs.seed('/thesis/00-管理/进度台账.md', '# 进度台账\n')
  return fs
}

test('detectKind：源码 → code；md/json/yaml/html 与清单仍走 text', () => {
  assert.equal(detectKind('/p/src/main.ts'), 'code')
  assert.equal(detectKind('/p/app.py'), 'code')
  assert.equal(detectKind('/p/Server.java'), 'code')
  assert.equal(detectKind('/p/cmd/main.go'), 'code')
  assert.equal(detectKind('/p/lib.rs'), 'code')
  assert.equal(detectKind('/p/README.md'), 'text')
  assert.equal(detectKind('/p/data.json'), 'text')
  assert.equal(detectKind('/p/config.yaml'), 'text')
  assert.equal(detectKind('/p/index.html'), 'text')
  assert.equal(detectKind('/p/package.json'), 'text')
  assert.equal(detectKind('/p/requirements.txt'), 'text')
})

test('单文件 code 摄取：只给结构摘要 + 明确"不要贴代码"的提示', () => {
  const source = new TextEncoder().encode([
    '// 用户服务',
    "import { db } from './db.ts'",
    '',
    'export class UserService {',
    '  async find(id: string): Promise<User | undefined> {',
    '    return db.query(id)',
    '  }',
    '}',
    '',
  ].join('\n'))
  const result = extractText(source, 'src/user-service.ts', OPTIONS)
  assert.equal(result.ok, true)
  assert.equal(result.kind, 'code')
  assert.match(result.text, /语言：typescript/)
  assert.match(result.text, /class UserService/)
  assert.match(result.text, /行数：9/)
  assert.ok(!result.text.includes('db.query'), '不得返回源码正文')
  assert.match(result.note ?? '', /结构摘要/)
  assert.match(result.note ?? '', /不要粘贴代码/)
})

test('目录摄取：代码结构摘要文件落盘，含语言/声明/技术栈', async () => {
  const fs = seededFs()
  const io = new FakeIO()
  io.add('/proj/src/app.ts', 'export function bootstrap(): void {}\n')
  io.add('/proj/src/store.py', 'class Store:\n    pass\n')
  io.add('/proj/README.md', '# 项目说明\n')
  io.add('/proj/package.json', JSON.stringify({
    name: 'proj',
    dependencies: { express: '^4.18.0', mysql2: '^3.0.0' },
    devDependencies: { typescript: '^5.0.0', vite: '^5.0.0' },
  }))

  const outcome = await runIngest(fs, io, { path: '/proj' }, '/thesis', OPTIONS)
  assert.ok(outcome.code !== undefined, '应产出代码结构汇总')
  assert.equal(outcome.code!.summaryPath, '00-管理/材料/proj-代码结构.md')
  assert.equal(outcome.code!.files, 2)
  assert.ok(outcome.code!.lines >= 3)

  const summary = fs.peek(`/thesis/00-管理/材料/proj-代码结构.md`)
  assert.ok(summary !== undefined, '摘要文件必须落盘到 00-管理/材料/')
  assert.match(summary, /# 代码结构摘要：\/proj/)
  assert.match(summary, /typescript/)
  assert.match(summary, /python/)
  assert.match(summary, /bootstrap/)
  assert.match(summary, /Store/)
  assert.match(summary, /Express/)
  assert.match(summary, /MySQL/)
  assert.match(summary, /Vite/)
  assert.ok(!summary.includes('README.md　（'), 'README 是材料不是源码，不应进代码结构表')
  assert.ok(outcome.written.includes('00-管理/材料/proj-代码结构.md'))
})

test('清单里有「代码结构」一节：文件数/行数/语言分布/技术栈/摘要路径', async () => {
  const fs = seededFs()
  const io = new FakeIO()
  io.add('/proj/main.go', 'package main\n\nfunc main() {}\n')
  io.add('/proj/go.mod', 'module demo\n\ngo 1.22\n\nrequire github.com/gin-gonic/gin v1.9.0\n')

  const outcome = await runIngest(fs, io, { path: '/proj' }, '/thesis', OPTIONS)
  assert.ok(outcome.code !== undefined)
  const manifest = fs.peek(`/thesis/${MANIFEST_REL}`)
  assert.ok(manifest !== undefined)
  assert.match(manifest, /## 代码结构/)
  assert.match(manifest, /源码文件：1 个，共 \d+ 行/)
  assert.match(manifest, /语言分布：go 1 个/)
  assert.match(manifest, /技术栈（由依赖清单推断，须核对）：.*Gin/)
  assert.match(manifest, /摘要文件：00-管理\/材料\/proj-代码结构\.md/)
  assert.match(manifest, /不要把源码正文贴进论文/)
})

test('超大依赖清单：如实进 skipped，不参与技术栈推断', async () => {
  const fs = seededFs()
  const io = new FakeIO()
  io.add('/proj/app.ts', 'export const version = 1\n')
  io.add('/proj/package.json', `{"name":"huge","dependencies":{"express":"1"},"pad":"${'x'.repeat(MAX_MANIFEST_BYTES + 64)}"}`)

  const outcome = await runIngest(fs, io, { path: '/proj' }, '/thesis', OPTIONS)
  assert.ok(outcome.code !== undefined)
  assert.equal(outcome.code!.stack.length, 0)
  assert.equal(outcome.code!.skipped.length, 1)
  assert.match(outcome.code!.skipped[0]!, /package\.json/)
  assert.match(outcome.code!.skipped[0]!, /超过/)

  const summary = fs.peek(`/thesis/00-管理/材料/proj-代码结构.md`)!
  assert.match(summary, /## 未纳入摘要的文件/)
  assert.match(summary, /package\.json/)
  assert.match(fs.peek(`/thesis/${MANIFEST_REL}`)!, /未纳入摘要：.*package\.json/)
})

test('摘要文件已存在时绝不覆盖（代码结构同样受红线约束）', async () => {
  const fs = seededFs()
  fs.seed('/thesis/00-管理/材料/proj-代码结构.md', '人工写好的旧摘要')
  const io = new FakeIO()
  io.add('/proj/app.ts', 'export const x = 1\n')

  const outcome = await runIngest(fs, io, { path: '/proj' }, '/thesis', OPTIONS)
  assert.ok(outcome.skipped.some(item => item.includes('proj-代码结构.md')))
  assert.equal(fs.peek('/thesis/00-管理/材料/proj-代码结构.md'), '人工写好的旧摘要')
  assert.ok(!outcome.written.includes('00-管理/材料/proj-代码结构.md'))
})
