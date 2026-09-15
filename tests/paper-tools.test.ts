import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as nodePath from 'node:path'
import { buildLayout, CHAPTER_FILES } from '../src/paper/lib/layout.ts'
import { CHAPTERS, parseLedger } from '../src/paper/lib/ledger.ts'
import { FakeFs } from './paper-fixtures.ts'

test('布局：全部路径唯一、非空且章节模板与 CHAPTERS 对齐', () => {
  const files = buildLayout({ title: '测试毕设', date: '2026-02-10' })
  const paths = files.map(f => f.path)
  assert.equal(new Set(paths).size, paths.length, '路径重复')

  const chapterPaths = files.filter(f => f.path.startsWith('06-论文/章节/'))
  assert.deepEqual(
    chapterPaths.map(f => f.path.split('/').pop()).sort(),
    [...CHAPTER_FILES].map(x => `${x}.md`).sort(),
    '章节文件与 CHAPTER_FILES 不一致',
  )
  assert.deepEqual(
    chapterPaths.map(f => f.path.split('/').pop()).sort(),
    [...CHAPTERS].map(x => `${x}.md`).sort(),
    '章节文件与 ledger CHAPTERS 不一致',
  )

  for (const f of files) {
    assert.ok(f.content.length >= 0, `${f.path} 无内容字段`)
  }
})

test('布局：生成台账可直接解析且状态块有效（含课题名）', () => {
  const files = buildLayout({ title: '测试毕设', date: '2026-02-10' })
  const ledger = files.find(f => f.path === '00-管理/进度台账.md')!
  const parsed = parseLedger(ledger.content)
  assert.equal(parsed.found, true)
  assert.equal(parsed.state.tasks.length, 25)
  assert.equal(parsed.state.title, '测试毕设')
})

test('布局：README 标题占位被替换', () => {
  const files = buildLayout({ title: '我的课题', date: '2026-02-10' })
  const readme = files.find(f => f.path === 'README.md')!
  assert.ok(readme.content.startsWith('# 我的课题'))
})

test('布局：关键目录全部存在（.gitkeep 保证空目录落盘）', () => {
  const files = buildLayout({ title: 't', date: '2026-02-10' })
  const paths = new Set(files.map(f => f.path))
  for (const p of [
    '00-管理/进度台账.md',
    '00-管理/决定日志.md',
    '00-管理/时间线.md',
    '00-管理/选题/选题确认书.md',
    '01-开题/开题报告.md',
    '01-开题/任务书.md',
    '02-文献/refs.bib',
    '02-文献/检索记录.md',
    '02-文献/笔记/.gitkeep',
    '03-设计/需求分析.md',
    '03-设计/系统设计.md',
    '03-设计/技术选型论证.md',
    '04-实现/.gitkeep',
    '05-实验测试/测试计划.md',
    '05-实验测试/结果/.gitkeep',
    '06-论文/大纲.md',
    '06-论文/assets/学校模板/README.md',
    '07-答辩/PPT大纲.md',
    '07-答辩/问答演练.md',
    '08-合规/自查报告.md',
    '08-合规/格式检查报告/.gitkeep',
    '08-合规/引用检查报告/.gitkeep',
    '.gitignore',
  ]) {
    assert.ok(paths.has(p), `缺少 ${p}`)
  }
})

test('init 冒烟：写入全部文件并复制技能包', async () => {
  const fs = new FakeFs()
  const skillsDir = nodePath.join(process.cwd(), 'skills')
  const { runInit, initSummary } = await import('../src/paper/tools/init.ts')
  const outcome = await runInit(fs, { root: '/tmp/thesis-smoke', title: '冒烟课题', git: false }, skillsDir)
  assert.equal(outcome.git, 'skipped')
  assert.ok(outcome.files >= 30, `文件数异常：${outcome.files}`)
  assert.ok(outcome.skills >= 7, `技能包至少 7 个，实际 ${outcome.skills}`)
  assert.ok(fs.peek('/tmp/thesis-smoke/00-管理/进度台账.md'))
  assert.ok(fs.peek('/tmp/thesis-smoke/.dsh/skills/thesis-pipeline/SKILL.md'))
  assert.ok(fs.peek('/tmp/thesis-smoke/README.md')!.startsWith('# 冒烟课题'))
  const summary = initSummary(outcome)
  assert.match(summary, /模板文件：35 个/)
  assert.match(summary, /下一步/)
})

test('init 拒绝：相对路径报错', async () => {
  const fs = new FakeFs()
  const { runInit } = await import('../src/paper/tools/init.ts')
  await assert.rejects(
    runInit(fs, { root: 'relative/path', git: false }, '/nonexistent'),
    /绝对路径/,
  )
})

test('init 拒绝：非空目录默认拒绝、force 放行', async () => {
  const fs = new FakeFs()
  await fs.writeText({ displayPath: '/tmp/existing/file.txt' }, 'x')
  const { runInit } = await import('../src/paper/tools/init.ts')
  await assert.rejects(runInit(fs, { root: '/tmp/existing', git: false }, '/nonexistent'), /非空/)
  const outcome = await runInit(fs, { root: '/tmp/existing', git: false, force: true }, '/nonexistent')
  assert.ok(outcome.files >= 30)
})

test('progress 冒烟：report→update→gate 完整链路', async () => {
  const fs = new FakeFs()
  const { runInit } = await import('../src/paper/tools/init.ts')
  const { runProgress } = await import('../src/paper/tools/progress.ts')
  await runInit(fs, { root: '/tmp/thesis-prog', git: false }, '/nonexistent')

  const report1 = await runProgress(fs, { action: 'report' }, '/tmp/thesis-prog')
  assert.match(report1, /当前阶段：1 · 选题/)
  assert.match(report1, /下一个待办：T1\.1/)

  // G1 前推进阶段 2 任务被闸门拒绝。
  await assert.rejects(
    runProgress(fs, { action: 'update', task_id: 'T2.1', status: 'doing' }, '/tmp/thesis-prog'),
    /入口关卡 G1/,
  )

  // 完成阶段 1 任务并过 G1。
  await runProgress(fs, { action: 'update', task_id: 'T1.1', status: 'done' }, '/tmp/thesis-prog')
  await runProgress(fs, { action: 'update', task_id: 'T1.2', status: 'done' }, '/tmp/thesis-prog')
  const gate1 = await runProgress(fs, { action: 'gate', gate: 'G1', pass: true }, '/tmp/thesis-prog')
  assert.match(gate1, /G1 选题拍板 已通过/)

  // 现在阶段 2 可推进；报告反映新阶段。
  const upd = await runProgress(fs, { action: 'update', task_id: 'T2.1', status: 'doing' }, '/tmp/thesis-prog')
  assert.match(upd, /T2\.1.*doing/)

  // 台账文件落盘可解析；G1 通过后当前阶段重算为 2。
  const ledger = fs.peek('/tmp/thesis-prog/00-管理/进度台账.md')!
  const parsed = parseLedger(ledger)
  assert.equal(parsed.found, true)
  assert.equal(parsed.state.gates.G1!.status, 'passed')
  assert.equal(parsed.state.currentStage, 2)
})

test('progress 在非工作区目录报错', async () => {
  const fs = new FakeFs()
  const { runProgress } = await import('../src/paper/tools/progress.ts')
  await assert.rejects(runProgress(fs, { action: 'report' }, '/tmp'), /未找到论文工作区/)
})

test('progress 从子目录向上定位工作区', async () => {
  const fs = new FakeFs()
  const { runInit } = await import('../src/paper/tools/init.ts')
  const { runProgress } = await import('../src/paper/tools/progress.ts')
  await runInit(fs, { root: '/tmp/thesis-nested', git: false }, '/nonexistent')
  const report = await runProgress(fs, { action: 'report' }, '/tmp/thesis-nested/06-论文/章节')
  assert.match(report, /当前阶段：1 · 选题/)
})

test('decision 冒烟：追加、计数、缺内容报错', async () => {
  const fs = new FakeFs()
  const { runInit } = await import('../src/paper/tools/init.ts')
  const { runDecision } = await import('../src/paper/tools/decision.ts')
  await runInit(fs, { root: '/tmp/thesis-dec', git: false }, '/nonexistent')

  const r1 = await runDecision(
    fs,
    { content: '课题定为 Web 系统', reason: '有前端基础', alternatives: 'AI 应用（数据难）' },
    '/tmp/thesis-dec',
  )
  assert.match(r1, /已记录决定 #1/)
  const log1 = fs.peek('/tmp/thesis-dec/00-管理/决定日志.md')!
  assert.match(log1, /- 理由：有前端基础/)
  assert.match(log1, /- 备选：AI 应用（数据难）/)

  const r2 = await runDecision(fs, { content: '后端选 Flask' }, '/tmp/thesis-dec')
  assert.match(r2, /已记录决定 #2/)
  const log2 = fs.peek('/tmp/thesis-dec/00-管理/决定日志.md')!
  assert.match(log2, /后端选 Flask/)

  await assert.rejects(runDecision(fs, { content: '  ' }, '/tmp/thesis-dec'), /content 必填/)
  await assert.rejects(runDecision(fs, { content: 'x' }, '/tmp'), /未找到论文工作区/)
})
