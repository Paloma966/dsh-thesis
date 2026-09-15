import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  appendDecision,
  applyGate,
  applyTaskUpdate,
  canUpdateTask,
  CHAPTERS,
  countDecisions,
  defaultState,
  defaultTimeline,
  gatePassed,
  parseLedger,
  parseTimeline,
  renderDecisionEntry,
  renderLedger,
  renderReport,
  renderTimeline,
  stateToJson,
} from '../src/paper/lib/ledger.ts'

test('台账：默认状态包含全部关卡与 25 个任务', () => {
  const state = defaultState()
  assert.deepEqual(Object.keys(state.gates).sort(), ['G1', 'G2', 'G3', 'G4'])
  assert.equal(state.tasks.length, 25)
  assert.equal(state.currentStage, 1)
  assert.deepEqual(Object.keys(state.gates.G2!.chapters!), CHAPTERS)
})

test('台账：渲染→解析 往返一致', () => {
  const state = defaultState(new Date('2026-02-10T08:00:00Z'))
  state.title = '测试课题'
  const md = renderLedger(state)
  const parsed = parseLedger(md)
  assert.equal(parsed.found, true)
  assert.deepEqual(parsed.state, state)
  assert.equal(stateToJson(parsed.state), stateToJson(state))
})

test('台账：状态块缺失时 found=false 并回退默认状态', () => {
  const parsed = parseLedger('# 进度台账\n\n（没有状态块）\n')
  assert.equal(parsed.found, false)
  assert.equal(parsed.state.tasks.length, 25)
})

test('闸门：G1 未通过时，阶段 2 任务拒绝进入 doing/done', () => {
  const state = defaultState()
  const task = state.tasks.find(t => t.id === 'T2.1')!
  assert.equal(canUpdateTask(state, task, 'doing').ok, false)
  assert.equal(canUpdateTask(state, task, 'done').ok, false)
  // 回到 todo 永远允许（纠错路径）。
  assert.equal(canUpdateTask(state, task, 'todo').ok, true)
})

test('闸门：G1 通过后阶段 2 可推进；阶段 1 始终可推进', () => {
  const state = defaultState()
  const t11 = state.tasks.find(t => t.id === 'T1.1')!
  const t12 = state.tasks.find(t => t.id === 'T1.2')!
  const t21 = state.tasks.find(t => t.id === 'T2.1')!
  assert.equal(canUpdateTask(state, t11, 'doing').ok, true)
  // 通过 G1 的完整前置链：T1.2 done → gate G1 pass。
  assert.equal(applyTaskUpdate(state, 'T1.2', 'done').ok, true)
  assert.equal(applyGate(state, 'G1', true).ok, true)
  assert.equal(gatePassed(state, 'G1'), true)
  assert.equal(canUpdateTask(state, t21, 'doing').ok, true)
})

test('闸门：关卡关联任务未完成时拒绝通过', () => {
  const state = defaultState()
  // T2.3 关联 G3，尚未 done。
  const result = applyGate(state, 'G3', true)
  assert.equal(result.ok, false)
  assert.match(result.reason, /T2\.3/)
  assert.equal(state.gates.G3!.status, 'pending')
})

test('闸门：G2 逐章验收，七章全过才整体通过', () => {
  const state = defaultState()
  // 先完成 G2 关联任务 T7.2（否则 applyGate 会因"任务未完成"拒绝——G2 分支实际不检查任务，验证章节逻辑即可）。
  for (const c of CHAPTERS) {
    assert.equal(applyGate(state, 'G2', true, { chapter: c }).ok, true)
  }
  assert.equal(gatePassed(state, 'G2'), true)
  assert.equal(state.gates.G2!.status, 'passed')
  // 重置一章后整体回到未通过。
  assert.equal(applyGate(state, 'G2', false, { chapter: '03-需求分析' }).ok, true)
  assert.equal(gatePassed(state, 'G2'), false)
})

test('闸门：G2 缺 chapter 参数时报错', () => {
  const state = defaultState()
  const result = applyGate(state, 'G2', true)
  assert.equal(result.ok, false)
  assert.match(result.reason, /chapter/)
})

test('报告：renderReport 包含阶段、关卡、下一个待办', () => {
  const state = defaultState(new Date('2026-02-10T08:00:00Z'))
  const report = renderReport(state)
  assert.match(report, /当前阶段：1 · 选题/)
  assert.match(report, /G1 选题拍板: 未通过/)
  assert.match(report, /下一个待办：T1\.1/)
})

test('决定日志：追加、计数与条目渲染', () => {
  const base = '# 决定日志\n\n'
  const entry = { date: '2026-02-10', title: '选题', content: '选择 Web 系统', reason: '有基础', alternatives: 'AI 应用' }
  const next = appendDecision(base, entry)
  assert.match(next, /## 2026-02-10 · 选题/)
  assert.match(next, /- 理由：有基础/)
  assert.equal(countDecisions(next), 1)
  const entry2 = renderDecisionEntry({ date: '2026-02-11', title: '选型', content: '用 Vue' })
  assert.match(entry2, /- 决定：用 Vue/)
  assert.equal(countDecisions(appendDecision(next, { date: '2026-02-11', title: 'x', content: 'y' })), 2)
})

test('时间线：默认 7 个里程碑，渲染→解析往返一致', () => {
  const t = defaultTimeline()
  assert.equal(t.milestones.length, 7)
  assert.equal(t.milestones[1]!.dependsOn[0], 'M1')
  const md = renderTimeline(t)
  const parsed = parseTimeline(md)
  assert.equal(parsed.found, true)
  assert.deepEqual(parsed.state, t)
})
