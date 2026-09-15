/**
 * `thesis_ingest` 工具测试：类型判定矩阵、unsupported 提示、maxChars 截断，
 * 以及 runIngest 的落盘行为（摘要文件、材料清单、绝不覆盖、无工作区不落盘）。
 *
 * 磁盘读取用内存 IO（`FakeIO`），工作区写入用内存 FileSystem（`FakeFs`）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as nodePath from 'node:path'
import { ingestCommand } from '../src/ingest/commands.ts'
import {
  MAX_MANIFEST_BYTES,
  MATERIAL_DIR,
  MANIFEST_REL,
  codeFileExtract,
  detectKind,
  extractDocument,
  parseGlobFilter,
  runIngest,
  summaryFileName,
  unsupportedReason,
} from '../src/ingest/index.ts'
import { buildDocx, buildPptx, buildXlsx, FakeFs, FakeIO } from './ingest-fixtures.ts'

const OPTIONS = { maxBytes: 32 * 1024 * 1024, maxChars: 60000 }

/**
 * 测试内统一用 `/` 写路径（可读），但 Windows 上生产代码会把它们解析成
 * `C:\...`，所以断言一律经过 `nodePath.resolve` 归一，避免平台差异。
 */
function abs(p: string): string {
  return nodePath.resolve(p)
}

/** 把路径统一成 `/` 分隔（跨平台比较用）。 */
function rel(p: string): string {
  return p.replace(/\\/g, '/')
}

// ---------------------------------------------------------------------------
// 类型判定与统一入口
// ---------------------------------------------------------------------------

test('detectKind：扩展名矩阵（docx/xlsx/pptx/pdf/text/code/unsupported）', () => {
  assert.equal(detectKind('/a/模板.DOCX'), 'docx')
  assert.equal(detectKind('/a/数据.xlsm'), 'xlsx')
  assert.equal(detectKind('/a/答辩.pptx'), 'pptx')
  assert.equal(detectKind('/a/要求.pdf'), 'pdf')
  assert.equal(detectKind('/a/要求.md'), 'text')
  assert.equal(detectKind('/a/refs.bib'), 'text')
  assert.equal(detectKind('/a/数据.csv'), 'text')
  assert.equal(detectKind('/a/index.html'), 'text')
  assert.equal(detectKind('/a/package.json'), 'text')
  assert.equal(detectKind('/a/src/main.ts'), 'code')
  assert.equal(detectKind('/a/app.py'), 'code')
  assert.equal(detectKind('C:\\proj\\Main.java'), 'code')
  assert.equal(detectKind('/a/论文.doc'), 'unsupported')
  assert.equal(detectKind('/a/表格.xls'), 'unsupported')
  assert.equal(detectKind('/a/旧演示.ppt'), 'unsupported')
  assert.equal(detectKind('/a/noext'), 'unsupported')
})

test('unsupportedReason：旧格式给出"另存为新格式"的明确指引', () => {
  assert.match(unsupportedReason('论文.doc'), /旧二进制 Office 格式/)
  assert.match(unsupportedReason('论文.doc'), /另存为.*docx/)
  assert.match(unsupportedReason('a.exe'), /不支持的文件类型/)
})

test('extractDocument：unsupported 返回 ok:false 而不是空文本', () => {
  const result = extractDocument(new Uint8Array(0), 'unsupported', OPTIONS)
  assert.equal(result.ok, false)
  assert.equal(result.text, '')
  assert.match(result.note ?? '', /不支持/)
})

test('extractDocument：code 只给结构摘要，不给源码正文', () => {
  const source = new TextEncoder().encode('export function computeTotal(items: number[]): number {\n  return items.reduce((a, b) => a + b, 0)\n}\n')
  const result = extractDocument(source, 'code', OPTIONS)
  assert.equal(result.ok, true)
  assert.equal(result.kind, 'code')
  assert.match(result.text, /语言：typescript/)
  assert.match(result.text, /主要声明：function computeTotal（第 1 行）/)
  assert.ok(!result.text.includes('reduce'), '不应包含源码实现细节')
  assert.match(result.note ?? '', /结构摘要/)
})

test('codeFileExtract：行数统计与声明索引', () => {
  const result = codeFileExtract('utils.py', 'def add(a, b):\n    return a + b\n\nclass Calc:\n    pass\n', OPTIONS)
  assert.match(result.text, /function add（第 1 行）/)
  assert.match(result.text, /class Calc（第 4 行）/)
  assert.match(result.text, /行数：6/)
})

test('parseGlobFilter / summaryFileName', () => {
  assert.deepEqual([...parseGlobFilter('docx, pdf，md')].sort(), ['.docx', '.md', '.pdf'])
  assert.deepEqual([...parseGlobFilter('*.ts')], ['.ts'])
  assert.deepEqual([...parseGlobFilter(undefined)], [])
  assert.equal(summaryFileName('sub/论文模板.docx'), '论文模板.md')
  assert.equal(summaryFileName('a/b/成绩单.xlsx'), '成绩单.md')
})

// ---------------------------------------------------------------------------
// runIngest：落盘
// ---------------------------------------------------------------------------

/** 准备一个论文工作区（含台账，findThesisRoot 才能定位）。 */
function seededFs(): FakeFs {
  const fs = new FakeFs()
  fs.seed('/thesis/00-管理/进度台账.md', '# 进度台账\n')
  return fs
}

function docxIO(rel: string, texts: readonly string[]): FakeIO {
  const io = new FakeIO()
  io.add(`/materials/${rel}`, buildDocx({ paragraphs: texts }))
  return io
}

test('runIngest：单文件抽取 + 摘要与清单落盘', async () => {
  const fs = seededFs()
  const io = docxIO('论文模板.docx', ['第一章 绪论', '第二章 相关工作'])
  const outcome = await runIngest(fs, io, { path: '/materials/论文模板.docx' }, '/thesis', OPTIONS)

  assert.equal(outcome.root, abs('/thesis'))
  assert.equal(outcome.files.length, 1)
  assert.equal(outcome.results[0]?.ok, true)
  assert.equal(outcome.results[0]?.kind, 'docx')
  assert.deepEqual(outcome.written, [`${MATERIAL_DIR}/论文模板.md`])

  const summary = fs.peek(`/thesis/${MATERIAL_DIR}/论文模板.md`)
  assert.ok(summary !== undefined, '摘要文件应落盘')
  assert.match(summary!, /- 原文件：论文模板.docx/)
  assert.match(summary!, /- 类型：docx/)
  assert.match(summary!, /- 截断：否/)
  assert.match(summary!, /- 低置信：否/)
  assert.match(summary!, /第一章 绪论/)

  const manifest = fs.peek(`/thesis/${MANIFEST_REL}`)
  assert.ok(manifest !== undefined, '清单应落盘')
  assert.match(manifest!, /# 材料清单/)
  assert.match(manifest!, /论文模板\.docx（docx/)
})

test('runIngest：绝不覆盖已存在的摘要（跳过并标注）', async () => {
  const fs = seededFs()
  fs.seed(`/thesis/${MATERIAL_DIR}/论文模板.md`, '已有内容，不可覆盖')
  const io = docxIO('论文模板.docx', ['新内容'])
  const outcome = await runIngest(fs, io, { path: '/materials/论文模板.docx' }, '/thesis', OPTIONS)

  assert.deepEqual(outcome.written, [])
  assert.equal(outcome.skipped.length, 1)
  assert.match(outcome.skipped[0]!, /已存在，跳过/)
  assert.equal(fs.peek(`/thesis/${MATERIAL_DIR}/论文模板.md`), '已有内容，不可覆盖')
  assert.match(fs.peek(`/thesis/${MANIFEST_REL}`)!, /已跳过/)
})

test('runIngest：目录递归、后缀过滤、跳过 SKIP_DIRS', async () => {
  const fs = seededFs()
  const io = new FakeIO()
  io.add('/proj/要求.docx', buildDocx({ paragraphs: ['评分标准'] }))
  io.add('/proj/说明.md', '# 说明\n正文')
  io.add('/proj/node_modules/lib/index.js', 'module.exports = 1')
  io.add('/proj/06-论文/产出/论文.docx', buildDocx({ paragraphs: ['不该读到'] }))

  const outcome = await runIngest(fs, io, { path: '/proj' }, '/thesis', OPTIONS)
  const rels = outcome.files.map(file => rel(file.rel)).sort()
  assert.equal(rels.length, 2, `应只读到 2 个文件：${rels.join('、')}`)
  assert.ok(rels.includes('说明.md') && rels.includes('要求.docx'), `文件清单异常：${rels.join('、')}`)

  // glob 只留 docx
  const only = await runIngest(fs, io, { path: '/proj', glob: 'docx' }, '/thesis', OPTIONS)
  assert.deepEqual(only.files.map(file => rel(file.rel)), ['要求.docx'])
})

test('runIngest：write=false 只返回结果不落盘', async () => {
  const fs = seededFs()
  const io = docxIO('模板.docx', ['正文'])
  const outcome = await runIngest(fs, io, { path: '/materials/模板.docx', write: false }, '/thesis', OPTIONS)
  assert.deepEqual(outcome.written, [])
  assert.equal(fs.peek(`/thesis/${MATERIAL_DIR}/模板.md`), undefined)
  assert.match(outcome.note ?? '', /write=false/)
})

test('runIngest：找不到论文工作区时只返回结果并说明', async () => {
  const fs = new FakeFs()
  const io = docxIO('模板.docx', ['正文'])
  const outcome = await runIngest(fs, io, { path: '/materials/模板.docx' }, '/elsewhere', OPTIONS)
  assert.equal(outcome.root, undefined)
  assert.deepEqual(outcome.written, [])
  assert.match(outcome.note ?? '', /未找到论文工作区/)
})

test('runIngest：相对路径拒绝、不存在路径报错、空目录报错', async () => {
  const fs = seededFs()
  const io = new FakeIO()
  await assert.rejects(runIngest(fs, io, { path: 'relative/x.docx' }, '/thesis', OPTIONS), /绝对路径/)
  await assert.rejects(runIngest(fs, io, { path: '/nope' }, '/thesis', OPTIONS), /路径不存在/)
  await assert.rejects(runIngest(fs, io, { path: '/empty' }, '/thesis', OPTIONS), /路径不存在/)
})

test('runIngest：失败文件如实进 failed 与清单', async () => {
  const fs = seededFs()
  const io = new FakeIO()
  io.add('/materials/旧格式.doc', 'not a real doc')
  const outcome = await runIngest(fs, io, { path: '/materials' }, '/thesis', OPTIONS)
  assert.equal(outcome.results[0]?.ok, false)
  assert.equal(outcome.failed.length, 1)
  assert.match(outcome.failed[0]?.reason ?? '', /旧二进制 Office 格式/)
  assert.match(fs.peek(`/thesis/${MANIFEST_REL}`)!, /失败/)
})

test('runIngest：xlsx/pptx 也能落盘（三格式端到端）', async () => {
  const fs = seededFs()
  const io = new FakeIO()
  io.add('/materials/实验数据.xlsx', buildXlsx({ sheets: [{ name: '成绩', rows: [[{ value: '姓名' }, { value: '分数' }], [{ value: '张三' }, { value: '90' }]] }] }))
  io.add('/materials/答辩.pptx', buildPptx([['答辩题目'], ['研究背景']]))
  const outcome = await runIngest(fs, io, { path: '/materials' }, '/thesis', OPTIONS)

  assert.equal(outcome.results.every(result => result.ok), true)
  assert.match(fs.peek(`/thesis/${MATERIAL_DIR}/实验数据.md`)!, /工作表：成绩/)
  assert.match(fs.peek(`/thesis/${MATERIAL_DIR}/答辩.md`)!, /第 1 页/)
})

// ---------------------------------------------------------------------------
// 代码结构
// ---------------------------------------------------------------------------

test('runIngest：目录摄取写入代码结构摘要并在清单里加"代码结构"一节', async () => {
  const fs = seededFs()
  const io = new FakeIO()
  io.add('/proj/src/index.ts', 'export function main(): void {}\nexport interface Options { a: number }\n')
  io.add('/proj/src/util.py', 'def helper():\n    pass\n')
  io.add('/proj/package.json', JSON.stringify({ name: 'demo', dependencies: { express: '^4' }, devDependencies: { typescript: '^5' } }))

  const outcome = await runIngest(fs, io, { path: '/proj' }, '/thesis', OPTIONS)
  assert.ok(outcome.code !== undefined, '应产出代码结构汇总')
  assert.equal(outcome.code!.files, 2)
  assert.ok(outcome.code!.stack.some(entry => entry.name === 'Express'))
  assert.equal(outcome.code!.summaryPath, `${MATERIAL_DIR}/proj-代码结构.md`)
  assert.ok(outcome.written.includes(outcome.code!.summaryPath))

  const summary = fs.peek(`/thesis/${outcome.code!.summaryPath}`)
  assert.ok(summary !== undefined, '代码结构摘要应落盘')
  assert.match(summary!, /# 代码结构摘要：\/proj/)
  assert.match(summary!, /typescript/)
  assert.match(summary!, /function\*\*? ?main|`function` \*\*main\*\*/)
  assert.match(summary!, /Express/)
  assert.match(summary!, /不要.*源码正文|不含源码正文/)

  const manifest = fs.peek(`/thesis/${MANIFEST_REL}`)!
  assert.match(manifest!, /## 代码结构/)
  assert.match(manifest!, /语言分布：/)
  assert.match(manifest!, /技术栈/)
  assert.match(manifest!, /不要把源码正文贴进论文/)
})

test('runIngest：超大依赖清单如实列入 skipped', async () => {
  const fs = seededFs()
  const io = new FakeIO()
  io.add('/proj/app.ts', 'export const x = 1\n')
  io.add('/proj/package.json', `{"pad":"${'x'.repeat(MAX_MANIFEST_BYTES + 100)}"}`)

  const outcome = await runIngest(fs, io, { path: '/proj' }, '/thesis', OPTIONS)
  assert.ok(outcome.code !== undefined)
  assert.equal(outcome.code!.stack.length, 0, '超大清单不参与技术栈推断')
  assert.ok(outcome.code!.skipped.some(item => item.includes('package.json')), `skipped 应列出超大清单：${outcome.code!.skipped.join('、')}`)
  const summary = fs.peek(`/thesis/${outcome.code!.summaryPath}`)!
  assert.match(summary, /未纳入摘要的文件/)
})

test('runIngest：代码文件过多摘要仍只吃结构，不贴正文', async () => {
  const fs = seededFs()
  const io = new FakeIO()
  for (let index = 0; index < 12; index += 1) {
    io.add(`/proj/src/mod${index}.ts`, `export function fn${index}(input: string): string {\n  return input.trim()\n}\n`)
  }
  const outcome = await runIngest(fs, io, { path: '/proj' }, '/thesis', OPTIONS)
  assert.equal(outcome.code!.files, 12)
  const summary = fs.peek(`/thesis/${outcome.code!.summaryPath}`)!
  assert.ok(!summary.includes('input.trim()'), '不应包含源码实现')
  assert.match(summary, /fn11/)
})

// ---------------------------------------------------------------------------
// /thesis-ingest 斜杠命令（实现由 src/ingest/commands.ts 提供）
// ---------------------------------------------------------------------------

test('ingestCommand：空参数给出用法，坏路径给出可读错误', async () => {
  const fs = seededFs()
  const command = ingestCommand(fs, OPTIONS) as {
    name: string
    handler: (invocation: unknown) => Promise<{ kind: string; text?: string }>
  }
  assert.equal(command.name, 'thesis-ingest')

  const empty = await command.handler({ rawInput: '   ', agent: { session: { header: { cwd: abs('/thesis') } } }, signal: undefined })
  assert.equal(empty.kind, 'error')
  assert.match(empty.text ?? '', /用法：\/thesis-ingest/)

  const badOption = await command.handler({ rawInput: '/x --nope', agent: { session: { header: { cwd: abs('/thesis') } } }, signal: undefined })
  assert.equal(badOption.kind, 'error')
  assert.match(badOption.text ?? '', /无法识别的选项/)

  const missing = await command.handler({ rawInput: '/definitely/not/here', agent: { session: { header: { cwd: abs('/thesis') } } }, signal: undefined })
  assert.equal(missing.kind, 'error')
  assert.match(missing.text ?? '', /路径不存在/)
})
