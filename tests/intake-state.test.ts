/**
 * 状态机测试：断点续问、幂等、原子写、损坏报错、规格渲染。
 *
 * 覆盖验收点：start → ask → answer 循环；重复回答同一个问题幂等；
 * `validate` 生效但不阻塞；重新加载状态后从正确的问题继续；
 * 状态文件损坏时的可读报错；规格包含每节、来源标注、未知项被标为阻塞且幂等。
 *
 * @module dsh-thesis/tests/intake-state
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyAnswer,
  applySkip,
  canTransition,
  defaultState,
  IntakeStateError,
  loadMaterials,
  loadStage,
  loadState,
  parseState,
  saveState,
  serializeState,
  setStage,
  stageFromLedger,
  writeAtomic,
  STATE_REL,
} from '../src/intake/state.ts'
import { makeContext, blockingRequired, listRequired, nextQuestion } from '../src/intake/questions.ts'
import { renderSpec, specFingerprint, writeSpec } from '../src/intake/spec.ts'
import { FakeFs, ledgerMarkdown, makeIo, materialsMarkdown, ROOT, workspace } from './intake-fixtures.ts'

const NOW = new Date('2026-01-05T00:00:00Z')

test('序列化稳定：同样状态两次序列化逐字节一致', () => {
  const a = defaultState(NOW, '00-管理/意图规格.md')
  a.answers['school.name'] = { value: 'XX大学 计算机学院', at: NOW.toISOString(), source: 'user', confirmed: true }
  const b = parseState(serializeState(a))
  assert.equal(serializeState(a), serializeState(b))
  assert.equal(serializeState(a).endsWith('\n'), true)
})

test('原子写：先写临时文件再改名，临时文件不残留', async () => {
  const fs = new FakeFs()
  const io = makeIo(fs)
  await writeAtomic(io, `${ROOT}/00-管理/意图规格.md`, 'hello')
  assert.equal(fs.files.get(`${ROOT}/00-管理/意图规格.md`), 'hello')
  assert.equal(fs.renames.length, 1, '必须走改名路径')
  assert.match(fs.renames[0]![0], /\.tmp-/, '改名源必须是临时文件')
  const leftovers = fs.paths().filter(p => p.includes('.tmp-'))
  assert.deepEqual(leftovers, [], '不应残留临时文件')
})

test('原子写兜底路径（无 rename 注入）也能落盘', async () => {
  const fs = new FakeFs()
  const io = makeIo(fs, { rename: false })
  await writeAtomic(io, `${ROOT}/a/b.md`, 'content')
  assert.equal(fs.files.get(`${ROOT}/a/b.md`), 'content')
  assert.deepEqual(fs.paths().filter(p => p.includes('.tmp-')), [])
})

test('状态读写：落盘 → 重新加载 → 断点续问从正确的问题继续', async () => {
  const fs = workspace({ stage: 1 })
  const io = makeIo(fs)
  const state = defaultState(NOW, '00-管理/意图规格.md')
  const ctx = makeContext({ found: false, items: [] }, '开题前')
  const first = nextQuestion(state, ctx)!
  applyAnswer(state, first.id, 'XX大学 计算机学院 软件工程', { now: NOW })
  await saveState(io, ROOT, state)

  // 模拟新会话：从磁盘重新读状态。
  const reloaded = await loadState(io, ROOT)
  assert.ok(reloaded !== undefined)
  assert.equal(reloaded!.answers[first.id]?.value, 'XX大学 计算机学院 软件工程')
  const next = nextQuestion(reloaded!, ctx)!
  assert.notEqual(next.id, first.id, '已回答的问题不应再问')
  assert.equal(next.required, true, '下一个仍然优先必答项')
})

test('重复回答同一个问题幂等：不刷新时间戳、不改动历史', async () => {
  const fs = workspace({})
  const io = makeIo(fs)
  const state = defaultState(NOW, '00-管理/意图规格.md')
  const soon = new Date('2026-02-01T00:00:00Z')
  const first = applyAnswer(state, 'school.name', 'XX大学', { now: NOW })
  assert.equal(first.changed, true)
  const before = serializeState(state)
  const again = applyAnswer(state, 'school.name', 'XX大学', { now: soon })
  assert.equal(again.changed, false)
  assert.equal(serializeState(state), before, '重复回答不得改动状态')
  assert.equal(state.answers['school.name']?.at, NOW.toISOString())
  assert.equal(state.updatedAt, NOW.toISOString())
})

test('重答必答项会把已完成的追问退回进行中', () => {
  const state = defaultState(NOW, '00-管理/意图规格.md')
  for (const q of listRequired()) applyAnswer(state, q.id, '已答内容', { now: NOW, valid: true })
  assert.equal(setStage(state, 'done').ok, true)
  assert.equal(state.stage, 'done')
  applyAnswer(state, 'school.name', '改成另一所学校', { now: NOW })
  assert.equal(state.stage, 'asking', '答案变了，规格必须重新收敛')
})

test('状态迁移校验：done 不会自动退回 asking', () => {
  const state = defaultState(NOW, '00-管理/意图规格.md')
  assert.equal(canTransition(state, 'done').ok, true)
  setStage(state, 'done')
  const back = canTransition(state, 'asking')
  assert.equal(back.ok, false)
  assert.match(back.reason, /不会自动退回/)
})

test('状态文件损坏 → 可读报错，绝不静默重置', async () => {
  const fs = workspace({})
  fs.files.set(`${ROOT}/${STATE_REL}`, '{ 这不是 JSON')
  const io = makeIo(fs)
  await assert.rejects(
    () => loadState(io, ROOT),
    (error: unknown) => {
      assert.ok(error instanceof IntakeStateError)
      assert.match(error.message, /不是合法 JSON/)
      assert.match(error.message, /intake\.json/)
      assert.match(error.message, /处理建议/)
      return true
    },
  )

  // 版本不符同样报错，而不是被当成新状态。
  fs.files.set(`${ROOT}/${STATE_REL}`, JSON.stringify({ version: 99 }))
  await assert.rejects(() => loadState(io, ROOT), (e: unknown) => e instanceof IntakeStateError && /version/.test(e.message))
})

test('状态解析：缺字段被补全，答案被规范化', () => {
  const raw = JSON.stringify({
    version: 1,
    stage: 'asking',
    askedIds: ['school.name'],
    answers: { 'school.name': { value: 'XX大学', at: '2026-01-01T00:00:00.000Z', source: 'materials', confirmed: false } },
    skipped: ['ref.samples'],
    skipReasons: { 'ref.samples': '暂时没有' },
  })
  const state = parseState(raw)
  assert.equal(state.stage, 'asking')
  assert.equal(state.answers['school.name']?.source, 'materials')
  assert.equal(state.answers['school.name']?.confirmed, false)
  assert.equal(state.specPath, '')
  assert.equal(state.skipReasons['ref.samples'], '暂时没有')
})

test('跳过必答项仍算阻塞（skip 不能代替回答）', () => {
  const state = defaultState(NOW, '00-管理/意图规格.md')
  applySkip(state, 'school.name', '材料里没写', NOW)
  assert.ok(blockingRequired(state).some(q => q.id === 'school.name'))
  assert.equal(state.skipReasons['school.name'], '材料里没写')
})

test('规格渲染：每节齐备、三种来源标注、未知项列为阻塞、幂等', () => {
  const state = defaultState(NOW, '00-管理/意图规格.md')
  applyAnswer(state, 'school.name', 'XX大学 计算机学院 软件工程', { now: NOW })
  applyAnswer(state, 'school.template', '01-材料/学校模板.docx', { source: 'materials', confirmed: false, now: NOW })
  const ctx = makeContext({ found: false, items: [] }, '开题前')
  const md = renderSpec(state, ctx)

  for (const section of ['学校与规范', '课题与目标', '时间线', '系统与数据', '文献与引用', '交付形式']) {
    assert.ok(md.includes(`## ${section}`), `规格缺少分节：${section}`)
  }
  assert.ok(md.includes('用户回答'))
  assert.ok(md.includes('材料推断（未确认）'))
  assert.ok(md.includes('未知（需补）'))
  assert.ok(md.includes('## 阻塞项'))
  assert.ok(md.includes('`school.degree`'), '未答必答项必须出现在阻塞项里')
  assert.ok(md.includes('这份文档是什么'), '文档头部必须说明它是什么、谁维护、怎么用')
  assert.equal(renderSpec(state, ctx), md, '同样状态渲染两次必须一致')
  assert.equal(specFingerprint(state), specFingerprint(parseState(serializeState(state))))

  // 规格落盘：路径与阻塞项都要返回。
  const fs = new FakeFs()
  const io = makeIo(fs)
  return (async () => {
    const written = await writeSpec(io, ROOT, state, ctx)
    assert.equal(written.path, '00-管理/意图规格.md')
    assert.ok(written.blockerIds.includes('school.degree'))
    assert.equal(fs.files.get(written.absPath.replace(/\\/g, '/')), md)
  })()
})

test('规格收敛后不再含闸门关键词（否则入口闸门会永远认为规格没立稳）', () => {
  // 闸门规则（src/intake/gate-rules.ts 的 judgeSpec）把这三个字面量当作未就绪：
  //   未知（需补） / 待确认 / 阻塞项：有
  // 全部必答项答完并确认后，规格里不能再出现它们。
  const state = defaultState(NOW, '00-管理/意图规格.md')
  for (const q of listRequired()) {
    applyAnswer(state, q.id, '已确认的测试答案', { now: NOW, valid: true, confirmed: true })
  }
  const md = renderSpec(state, makeContext({ found: false, items: [] }, '开题前'))
  assert.ok(!md.includes('未知（需补）'), '收敛后不应再出现「未知（需补）」')
  assert.ok(!md.includes('待确认'), '收敛后不应再出现「待确认」')
  assert.ok(!md.includes('阻塞项：有'), '收敛后不应出现「阻塞项：有」')
  assert.ok(md.includes('无。全部必答项已齐全。'))

  // 未收敛时必须出现阻塞标记，让闸门拦下写作。
  const pending = defaultState(NOW, '00-管理/意图规格.md')
  const mdPending = renderSpec(pending, makeContext({ found: false, items: [] }, '开题前'))
  assert.ok(mdPending.includes('未知（需补）'))
})

test('材料清单与台账读取：宽容且能推断阶段', async () => {
  const fs = workspace({
    stage: 3,
    materials: materialsMarkdown([{ file: '01-材料/数据.csv', kind: '实验数据' }]),
  })
  const io = makeIo(fs)
  const materials = await loadMaterials(io, ROOT)
  assert.equal(materials.found, true)
  assert.equal(materials.items.length, 1)
  assert.equal(await loadStage(io, ROOT), '文献调研')

  // 台账缺失 → 阶段读不出来（调用方落到默认「开题前」）。
  const bare = new FakeFs()
  assert.equal(await loadStage(makeIo(bare), ROOT), undefined)
  assert.equal(stageFromLedger(undefined), undefined)
  assert.equal(stageFromLedger('没有状态块'), undefined)
  assert.equal(stageFromLedger(ledgerMarkdown(9)), '答辩')
  assert.equal(stageFromLedger('<!-- thesis:state\n{ 坏 JSON\n-->'), undefined)
})
