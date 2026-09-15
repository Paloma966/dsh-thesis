import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  countTestCases,
  extractDecisionTitles,
  extractHeadings,
  extractTechChoices,
  renderDefenseMaterials,
  renderQuestionBank,
  type GitRunner,
} from '../src/paper/lib/defense.ts'
import { FakeFs } from './paper-fixtures.ts'

test('defense：标题提取（跳过 # 之外的层级与正文）', () => {
  const text = [
    '# 第 1 章 绪论',
    '## 1.1 研究背景与意义',
    '正文段落。',
    '### 1.1.1 三级标题',
    '#### 1.1.1.1 四级不算',
  ].join('\n')
  assert.deepEqual(extractHeadings(text), ['第 1 章 绪论', '1.1 研究背景与意义', '1.1.1 三级标题'])
})

test('defense：技术选型表提取（跳过表头与分隔行）', () => {
  const text = [
    '| 选型项 | 选择 | 理由 | 备选 | 弃用原因 |',
    '|---|---|---|---|---|',
    '| 后端框架 | Flask | 轻量易学 | Django | 学习成本高 |',
    '| 数据库 | MySQL | 生态成熟 | PostgreSQL | 暂不需要高级特性 |',
    '',
    '说明文字。',
  ].join('\n')
  const rows = extractTechChoices(text)
  assert.equal(rows.length, 2)
  assert.equal(rows[0]![0], '后端框架')
  assert.equal(rows[1]![1], 'MySQL')
})

test('defense：决定日志标题 + 测试用例计数', () => {
  const log = '# 决定日志\n\n## 2026-02-10 · 课题定为 Web 系统\n\n- 决定：…\n\n## 2026-03-01 · 选型 Flask\n'
  assert.deepEqual(extractDecisionTitles(log), ['2026-02-10 课题定为 Web 系统', '2026-03-01 选型 Flask'])
  const plan = '| 用例 ID | 对应需求 | 步骤 | 预期结果 |\n|---|---|---|---|\n| TC-1 | FR-1 | … | … |\n| TC-2 | FR-1 | … | … |\n'
  assert.equal(countTestCases(plan), 2)
})

test('defense：素材渲染包含全部章节信息与诚实占位', () => {
  const git: GitStats = { commits: 42, firstCommit: '2026-02-10', lastCommit: '2026-05-20', ok: true }
  const out = renderDefenseMaterials({
    title: '基于深度学习的课堂抬头率检测系统',
    chapters: [
      { name: '01-绪论', no: 1, title: '绪论', cjk: 2100, headings: ['第 1 章 绪论', '1.1 研究背景与意义'], citations: 3 },
    ],
    techChoices: [['后端框架', 'Flask', '轻量易学', 'Django']],
    decisions: ['2026-02-10 课题定为抬头率检测'],
    testCases: 5,
    resultFiles: ['截图-功能1.png'],
    bibCount: 12,
    git,
  })
  assert.match(out, /基于深度学习的课堂抬头率检测系统/)
  assert.match(out, /第 1 章 绪论（2100 字，引用 3 处）/)
  assert.match(out, /Flask（理由：轻量易学；备选：Django）/)
  assert.match(out, /测试用例：5 个/)
  assert.match(out, /提交：42 次/)
  assert.match(out, /2026-02-10 ~ 2026-05-20/)
  assert.match(out, /收录 12 条/)
})

test('defense：问题库六类 + 占位符 + 回答记录区', () => {
  const out = renderQuestionBank('课题 X')
  assert.equal((out.match(/^## [一二三四五六]、/gm) ?? []).length, 6)
  assert.match(out, /<核心模块>/)
  assert.match(out, /<技术 A>/)
  assert.match(out, /## 我的回答记录/)
  const openCount = (out.match(/- \[ \]/g) ?? []).length
  assert.ok(openCount >= 18, `问题数应 ≥18，实际 ${openCount}`)
})

test('defense 工具流：素材与问题库落盘', async () => {
  const fs = new FakeFs()
  const { runInit } = await import('../src/paper/tools/init.ts')
  const { runDefensePrep } = await import('../src/paper/tools/defense.ts')
  await runInit(fs, { root: '/tmp/thesis-def', title: '课堂抬头率检测系统', git: false }, '/nonexistent')

  // 写一章 + 选型 + 决定 + 测试
  await fs.writeText({ displayPath: '/tmp/thesis-def/06-论文/章节/07-总结与展望.md' }, '研'.repeat(900))
  await fs.writeText(
    { displayPath: '/tmp/thesis-def/03-设计/技术选型论证.md' },
    '| 选型项 | 选择 | 理由 | 备选 | 弃用原因 |\n|---|---|---|---|---|\n| 后端框架 | Flask | 轻量 | Django | 重 |\n',
  )
  await fs.writeText({ displayPath: '/tmp/thesis-def/00-管理/决定日志.md' }, '# 决定日志\n\n## 2026-02-10 · 课题定为抬头率检测\n')
  await fs.writeText({ displayPath: '/tmp/thesis-def/05-实验测试/测试计划.md' }, '| TC-1 | FR-1 | … | … |\n')
  await fs.writeText({ displayPath: '/tmp/thesis-def/05-实验测试/结果/截图1.png' }, 'PNG')

  const fakeGit: GitRunner = () => ({ commits: 7, firstCommit: '2026-02-01', lastCommit: '2026-02-10', ok: true })
  const out = await runDefensePrep(fs, '/tmp/thesis-def', undefined, fakeGit)
  assert.match(out, /答辩素材与问题库已生成/)
  assert.match(out, /已撰写 1 章/)
  assert.match(out, /git 7 次提交/)

  const materials = fs.peek('/tmp/thesis-def/07-答辩/答辩素材.md')!
  assert.match(materials, /课堂抬头率检测系统/)
  assert.match(materials, /Flask（理由：轻量；备选：Django）/)
  assert.match(materials, /2026-02-10 课题定为抬头率检测/)
  assert.match(materials, /测试用例：1 个/)
  assert.match(materials, /截图1.png/)

  const bank = fs.peek('/tmp/thesis-def/07-答辩/预答辩问题库.md')!
  assert.match(bank, /课堂抬头率检测系统/)
  assert.match(bank, /实现细节/)

  // git 统计失败时如实呈现
  const badGit: GitRunner = () => ({ commits: 0, ok: false, error: 'no repo' })
  await runDefensePrep(fs, '/tmp/thesis-def', undefined, badGit)
  const materials2 = fs.peek('/tmp/thesis-def/07-答辩/答辩素材.md')!
  assert.match(materials2, /git 统计不可用：no repo/)

  // 工作区外报错
  await assert.rejects(runDefensePrep(fs, '/tmp', undefined, fakeGit), /未找到论文工作区/)
})
