import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildZip, crc32, zipContainsName } from '../src/paper/lib/zip.ts'
import { buildDocx, parseMarkdownBlocks } from '../src/paper/lib/docx.ts'
import { runGlobalCheck, type CheckChapter } from '../src/paper/lib/check.ts'
import { renderAiSelfcheck, runAiSelfcheck } from '../src/paper/lib/aicheck.ts'
import { FakeFs } from './paper-fixtures.ts'

// ---------------------------------------------------------------------------
// zip
// ---------------------------------------------------------------------------

test('zip：CRC32 已知向量 + 结构签名', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926)
  const zip = buildZip([{ name: 'a.txt', data: new TextEncoder().encode('hello') }])
  // PK\x03\x04 本地头
  assert.equal(zip[0], 0x50)
  assert.equal(zip[1], 0x4b)
  assert.equal(zip[2], 0x03)
  assert.equal(zip[3], 0x04)
  // EOCD 签名在尾部（22 字节固定尾部）
  const eocd = zip.length - 22
  assert.equal(zip[eocd], 0x50)
  assert.equal(zip[eocd + 1], 0x4b)
  assert.equal(zip[eocd + 2], 0x05)
  assert.equal(zip[eocd + 3], 0x06)
  assert.ok(zipContainsName(zip, 'a.txt'))
  assert.equal(zipContainsName(zip, 'missing.txt'), false)
})

test('zip：多条目 + UTF-8 名称', () => {
  const zip = buildZip([
    { name: '[Content_Types].xml', data: new Uint8Array([1, 2, 3]) },
    { name: 'word/文档.xml', data: new Uint8Array([4, 5, 6]) },
  ])
  assert.ok(zipContainsName(zip, '[Content_Types].xml'))
  assert.ok(zipContainsName(zip, 'word/文档.xml'))
})

// ---------------------------------------------------------------------------
// docx
// ---------------------------------------------------------------------------

test('docx：块解析（标题/段落/列表/表格/分隔行跳过）', () => {
  const md = [
    '# 第 1 章 绪论',
    '',
    '## 1.1 背景',
    '',
    '普通段落 **加粗** 内容。',
    '',
    '- 要点一',
    '- 要点二',
    '',
    '| 列A | 列B |',
    '|---|---|',
    '| x | y |',
  ].join('\n')
  const blocks = parseMarkdownBlocks(md)
  assert.equal(blocks[0]!.kind, 'h1')
  assert.equal(blocks[1]!.kind, 'h2')
  assert.equal(blocks[2]!.kind, 'p')
  assert.equal(blocks[3]!.kind, 'bullet')
  assert.equal(blocks[4]!.kind, 'bullet')
  const table = blocks[5]!
  assert.equal(table.kind, 'table')
  assert.deepEqual(table.rows, [['列A', '列B'], ['x', 'y']])
})

test('docx：装配后包含全部部件、标题页与转义', () => {
  const docx = buildDocx({ title: '基于深度学习的<检测>系统', markdown: '# 第 1 章 绪论\n\n内容 **重点** 与 [链接](https://x) 文字。\n' })
  for (const part of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/_rels/document.xml.rels']) {
    assert.ok(zipContainsName(docx, part), `缺少 ${part}`)
  }
  // 找到 document.xml 的内容切片（在整个 zip 字节流中搜索转义后的标题）
  const bytes = docx
  const needle = '基于深度学习的&lt;检测&gt;系统'
  const found = (() => {
    const enc = new TextEncoder().encode(needle)
    outer: for (let i = 0; i + enc.length <= bytes.length; i += 1) {
      for (let j = 0; j < enc.length; j += 1) {
        if (bytes[i + j] !== enc[j]) continue outer
      }
      return true
    }
    return false
  })()
  assert.ok(found, '标题应转义后出现在 document.xml 中')
})

// ---------------------------------------------------------------------------
// check（全文综合）
// ---------------------------------------------------------------------------

function chapters(parts: Array<[string, number, string]>): CheckChapter[] {
  return parts.map(([name, no, text]) => ({ name, no, text }))
}

test('check：引用双向一致（超出/躺尸/不连续/为空）', () => {
  const bib1 = ['@article{k1, title={T1}, author={A}, journal={J}, year={2020}}', '@article{k2, title={T2}, author={B}, journal={J}, year={2021}}', '@article{k3, title={T3}, author={C}, journal={J}, year={2022}}'].join('\n')
  const report = runGlobalCheck({
    chapters: chapters([
      ['01-绪论', 1, '研究现状见文献[1,3]。'.padEnd(120, '研')],
      ['07-总结与展望', 7, '研'.repeat(900)],
    ]),
    bibText: bib1,
    templateFiles: ['模板.docx'],
  })
  const cit = report.sections.find(s => s.id === 'citations')!
  assert.equal(cit.ok, true)
  assert.match(cit.lines.join('\n'), /从未被正文引用：k2/)
  assert.match(cit.lines.join('\n'), /缺 \[2\]/)

  const over = runGlobalCheck({
    chapters: chapters([['01-绪论', 1, '引用[5]。'.padEnd(120, '研')]]),
    bibText: '@article{k1, title={T}, author={A}, journal={J}, year={2020}}',
    templateFiles: [],
  })
  assert.equal(over.sections.find(s => s.id === 'citations')!.ok, false)
})

test('check：术语定义先于使用 + 模板探测', () => {
  const report = runGlobalCheck({
    chapters: chapters([
      ['01-绪论', 1, `本系统采用 CNN 进行识别。`.padEnd(2000, '研')],
      ['02-相关技术', 2, `卷积神经网络（CNN）是……`.padEnd(1600, '研')],
    ]),
    bibText: '',
    templateFiles: [],
  })
  const terms = report.sections.find(s => s.id === 'terms')!
  assert.equal(terms.ok, false)
  assert.match(terms.lines.join('\n'), /CNN 在第 2 章才定义/)
  const template = report.sections.find(s => s.id === 'template')!
  assert.equal(template.ok, false)
  assert.match(template.lines.join('\n'), /未发现模板文件/)

  const withTpl = runGlobalCheck({
    chapters: chapters([['07-总结与展望', 7, '研'.repeat(900)]]),
    bibText: '',
    templateFiles: ['本科毕业论文模板.docx'],
  })
  assert.equal(withTpl.sections.find(s => s.id === 'template')!.ok, true)
})

test('check：字数统计与图表编号（章级）', () => {
  const report = runGlobalCheck({
    chapters: chapters([
      ['01-绪论', 1, `${'研'.repeat(300)} 如图 3-1 所示。`],
    ]),
    bibText: '',
    templateFiles: ['t.docx'],
  })
  const words = report.sections.find(s => s.id === 'words')!
  assert.match(words.lines.join('\n'), /01-绪论：3\d\d 字 \/ 目标 2000-2500/)
  const figures = report.sections.find(s => s.id === 'figures')!
  assert.equal(figures.ok, false)
  assert.match(figures.lines.join('\n'), /图 3-1/)
})

// ---------------------------------------------------------------------------
// aicheck
// ---------------------------------------------------------------------------

test('aicheck：六条规则命中 + 干净文本零命中', () => {
  const dirty = [
    '# 第 1 章 绪论',
    '',
    '综上所述，随着信息技术的不断发展，本系统具有一定的意义。'.padEnd(80, '研'),
    '',
    '随着人工智能技术不断发展，其性能被用于各类场景。'.padEnd(80, '研'),
    '',
    '随着人工智能技术不断进步，其应用被用于各类场景。'.padEnd(80, '研'),
    '',
    '随着人工智能技术不断完善，其方法被用于各类场景。'.padEnd(80, '研'),
    '',
    '本方法被用于进行深入的研究。作为AI生成的内容。'.padEnd(90, '研'),
    '',
    '研'.repeat(150), // 无锚点长段落
  ].join('\n')
  const report = runAiSelfcheck([{ name: '01-绪论', text: dirty }])
  const rules = report.chapters[0]!.findings.map(f => f.rule)
  assert.ok(rules.includes('模板套话'), '套话应命中')
  assert.ok(rules.includes('空洞结论句'), '空洞句应命中')
  assert.ok(rules.includes('自我暴露'), '自我暴露应命中')
  assert.ok(rules.includes('翻译腔'), '翻译腔应命中')
  assert.ok(rules.includes('句式单一'), '句式单一应命中')
  assert.ok(rules.includes('无锚点段落'), '无锚点应命中')
  const self = report.chapters[0]!.findings.find(f => f.rule === '自我暴露')!
  assert.equal(self.level, 'error')
  assert.ok(report.errorCount >= 1)
  const rendered = renderAiSelfcheck(report)
  assert.match(rendered, /✗ 自我暴露/)

  const clean = '# 第 7 章 总结与展望\n\n本系统实现了基于 YOLOv8 的抬头率检测，在自建 1200 张数据集上 mAP 达 91.3%，图 7-1 给出了对比结果。\n\n不足在于夜间场景识别率下降 8.2%，后续将扩充低光照数据并优化数据增强策略。\n'
  const cleanReport = runAiSelfcheck([{ name: '07-总结与展望', text: clean }])
  assert.equal(cleanReport.totalFindings, 0)
})

// ---------------------------------------------------------------------------
// 工具流（FakeFs）
// ---------------------------------------------------------------------------

test('M4 工具流：check/aicheck/build 在真实工作区结构上运行', async () => {
  const fs = new FakeFs()
  const { runInit } = await import('../src/paper/tools/init.ts')
  const { runCheck } = await import('../src/paper/tools/check.ts')
  const { runAiSelfcheckTool } = await import('../src/paper/tools/aicheck.ts')
  const { runBuild, buildSummary } = await import('../src/paper/tools/build.ts')
  await runInit(fs, { root: '/tmp/thesis-m4', title: '基于深度学习的课堂抬头率检测系统', git: false }, '/nonexistent')

  // 写一章 + 一条文献
  await fs.writeText(
    { displayPath: '/tmp/thesis-m4/06-论文/章节/07-总结与展望.md' },
    [
      '# 第 7 章 总结与展望',
      '',
      '## 7.1 工作总结',
      '研'.repeat(450),
      '本系统采用 CNN 识别，如文献[1]所述。',
      '',
      '## 7.2 不足与展望',
      '研'.repeat(450),
      '综上所述，本工作具有一定的意义。',
    ].join('\n'),
  )
  await fs.writeText(
    { displayPath: '/tmp/thesis-m4/02-文献/refs.bib' },
    '@article{k1,\n  title={T},\n  author={A B},\n  journal={J},\n  year={2020}\n}\n',
  )

  // check
  const checkOut = await runCheck(fs, '/tmp/thesis-m4')
  assert.match(checkOut, /引用双向一致/)
  assert.match(checkOut, /术语定义先于使用/)
  // 报告文件名含日期，验证目录下确实有文件（.gitkeep 之外）
  const citationFiles = (await fs.listDir({ displayPath: '/tmp/thesis-m4/08-合规/引用检查报告' })).filter(e => !e.name.startsWith('.'))
  assert.equal(citationFiles.length, 1)
  assert.match(citationFiles[0]!.name, /^检查-\d{4}-\d{2}-\d{2}\.md$/)
  const formatFiles = (await fs.listDir({ displayPath: '/tmp/thesis-m4/08-合规/格式检查报告' })).filter(e => !e.name.startsWith('.'))
  assert.equal(formatFiles.length, 1)

  // aicheck
  const aiOut = await runAiSelfcheckTool(fs, '/tmp/thesis-m4')
  assert.match(aiOut, /综上所述/)
  const aiReport = fs.peek('/tmp/thesis-m4/08-合规/AI味自查报告.md')!
  assert.match(aiReport, /自我暴露|模板套话|空洞结论句|翻译腔/)

  // build（internal 引擎）
  const captured: { path: string; bytes: Uint8Array }[] = []
  const outcome = await runBuild(
    fs,
    { engine: 'internal', format: 'docx' },
    '/tmp/thesis-m4',
    undefined,
    async (path, bytes) => captured.push({ path, bytes }),
  )
  assert.equal(outcome.engine, 'internal')
  assert.equal(outcome.chapters.length, 1)
  assert.ok(outcome.docxPath.endsWith('论文.docx'))
  assert.equal(captured.length, 1)
  assert.equal(captured[0]!.bytes[0], 0x50)
  assert.equal(captured[0]!.bytes[1], 0x4b)
  const summary = buildSummary(outcome)
  assert.match(summary, /内置过渡引擎/)
  const note = fs.peek('/tmp/thesis-m4/06-论文/产出/构建说明.md')!
  assert.match(note, /内置过渡引擎/)

  // pdf + internal → 拒绝
  await assert.rejects(
    runBuild(fs, { engine: 'internal', format: 'pdf' }, '/tmp/thesis-m4', undefined, async () => {}),
    /PDF 需要 pandoc|内置引擎只能产出 docx/,
  )
})
