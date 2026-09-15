import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chapterMetaFor } from '../src/paper/lib/layout.ts'
import { renderReviewReport, reviewChapter } from '../src/paper/lib/review.ts'
import { FakeFs } from './paper-fixtures.ts'

const BIB_ONE = '@article{x2020y,\n  author = {A B},\n  title = {T},\n  journal = {J},\n  year = {2020},\n  doi = {10.1/x}\n}\n'

function meta(file: string) {
  const located = chapterMetaFor(file)
  assert.ok(located, `${file} 应在章节元数据中`)
  return located
}

test('review：问题章全部问题被检出', () => {
  const located = meta('01-绪论')
  const problemText = [
    '# 第 1 章 绪论',
    '',
    '## 1.1 研究背景与意义',
    '这段很短。',
    '',
    '## 1.2 国内外研究现状',
    '这里引用了文献[5]。',
    '',
    // 缺少 1.3、1.4
    '',
    '如图 1-2 所示，以及错误的图 3-1。',
    '',
    '（待补）一个 TODO 项。',
    '',
    '## 本章 G2 验收清单',
    '- [ ] 第一项',
    '- [x] 第二项',
    '- [ ] 第三项',
    '- [ ] 第四项',
  ].join('\n')
  const report = reviewChapter({ chapterText: problemText, bibText: BIB_ONE, meta: located.meta, chapterNo: located.chapterNo })
  assert.equal(report.allOk, false)
  const byCheck = new Map(report.findings.map(f => [f.check, f]))
  assert.equal(byCheck.get('字数')!.ok, false, '字数过低应检出')
  assert.equal(byCheck.get('大纲')!.ok, false, '缺少 1.3/1.4 应检出')
  assert.match(byCheck.get('大纲')!.detail, /1\.3 本文主要工作、1\.4 论文组织结构/)
  assert.equal(byCheck.get('引用')!.ok, false, '[5] 超出 1 条文献库应检出')
  assert.match(byCheck.get('引用')!.detail, /\[5\] 超出文献库/)
  assert.equal(byCheck.get('图编号')!.ok, false, '图编号问题应检出')
  assert.match(byCheck.get('图编号')!.detail, /3-1/)
  assert.equal(byCheck.get('未完成标记')!.ok, false)
  assert.equal(byCheck.get('G2 清单')!.ok, false, '3 项未勾选应检出')
  const rendered = renderReviewReport(report)
  assert.match(rendered, /4 项检查未通过|5 项检查未通过|6 项检查未通过|7 项检查未通过/)
})

test('review：干净章全部通过', () => {
  const located = meta('01-绪论')
  const body = '研'.repeat(520) // 4 节 × 520 ≈ 2080 字，落在 2000-2500 区间
  const cleanText = [
    '# 第 1 章 绪论',
    '',
    '## 1.1 研究背景与意义',
    body,
    '',
    '## 1.2 国内外研究现状',
    `${body} 相关研究见文献[1]。`,
    '',
    '## 1.3 本文主要工作',
    body,
    '',
    '## 1.4 论文组织结构',
    body,
    '',
    '如图 1-1 所示。',
    '图 1-1 系统总体架构图',
    '',
    '## 本章 G2 验收清单',
    '- [x] 第一项',
    '- [x] 第二项',
    '- [x] 第三项',
    '- [x] 第四项',
  ].join('\n')
  const report = reviewChapter({ chapterText: cleanText, bibText: BIB_ONE, meta: located.meta, chapterNo: located.chapterNo })
  for (const f of report.findings) {
    assert.equal(f.ok, true, `${f.check} 应通过：${f.detail}`)
  }
  assert.equal(report.allOk, true)
  const rendered = renderReviewReport(report)
  assert.match(rendered, /全部确定性检查通过/)
})

test('review：引用解析 [1]、[2-4]、[1,3,5] 展开', () => {
  const located = meta('01-绪论')
  const body = '研'.repeat(2100)
  const text = [
    '# 第 1 章 绪论',
    '## 1.1 研究背景与意义', body,
    '## 1.2 国内外研究现状', `${body} 见文献[1,3][2-4]。`,
    '## 1.3 本文主要工作', body,
    '## 1.4 论文组织结构', body,
  ].join('\n')
  const bib = ['@article{a1, title={T1}, author={A}, journal={J}, year={2020}}', '@article{a2, title={T2}, author={B}, journal={J}, year={2021}}', '@article{a3, title={T3}, author={C}, journal={J}, year={2022}}', '@article{a4, title={T4}, author={D}, journal={J}, year={2023}}'].join('\n')
  const report = reviewChapter({ chapterText: text, bibText: bib, meta: located.meta, chapterNo: located.chapterNo })
  const cite = report.findings.find(f => f.check === '引用')!
  assert.equal(cite.ok, true, cite.detail)
  assert.match(cite.detail, /1、2、3、4/)
})

test('review：表编号独立检查；字数边界', () => {
  const located = meta('07-总结与展望') // 目标 800-1200
  const base = (n: number) => [
    '# 第 7 章 总结与展望',
    '## 7.1 工作总结',
    '研'.repeat(n),
    '## 7.2 不足与展望',
    '研'.repeat(n),
  ].join('\n')

  const low = reviewChapter({ chapterText: base(300), bibText: '', meta: located.meta, chapterNo: located.chapterNo })
  assert.equal(low.findings.find(f => f.check === '字数')!.ok, false)

  const ok = reviewChapter({ chapterText: base(500), bibText: '', meta: located.meta, chapterNo: located.chapterNo })
  assert.equal(ok.findings.find(f => f.check === '字数')!.ok, true)

  // 表编号：第 7 章出现表 7-1、7-2 连续 → 通过；缺 7-1 → 检出
  const withTables = base(500) + '\n表 7-1 结果对比\n表 7-2 补充数据\n'
  const t1 = reviewChapter({ chapterText: withTables, bibText: '', meta: located.meta, chapterNo: located.chapterNo })
  assert.equal(t1.findings.find(f => f.check === '表编号')!.ok, true)
  const broken = base(500) + '\n表 7-2 补充数据\n'
  const t2 = reviewChapter({ chapterText: broken, bibText: '', meta: located.meta, chapterNo: located.chapterNo })
  assert.equal(t2.findings.find(f => f.check === '表编号')!.ok, false)
})

test('review 工具：工作区内评审链路 + 错误路径', async () => {
  const fs = new FakeFs()
  const { runInit } = await import('../src/paper/tools/init.ts')
  const { runReview } = await import('../src/paper/tools/review.ts')
  await runInit(fs, { root: '/tmp/thesis-rev', git: false }, '/nonexistent')

  // 模板章（未动笔）应有字数/大纲/G2 清单问题
  const out = await runReview(fs, { chapter: '01-绪论' }, '/tmp/thesis-rev')
  assert.match(out, /章节评审报告：01-绪论/)
  assert.match(out, /✗ 字数/)
  assert.match(out, /✗ G2 清单/)

  // 未知章节
  await assert.rejects(runReview(fs, { chapter: '99-不存在' }, '/tmp/thesis-rev'), /未知章节/)

  // 工作区外
  await assert.rejects(runReview(fs, { chapter: '01-绪论' }, '/tmp'), /未找到论文工作区/)

  // 未生成的章节文件（07 存在模板，应可评审；改用不存在的目录名直接报"未知章节"已覆盖）
})
