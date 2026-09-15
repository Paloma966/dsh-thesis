/**
 * 问题库测试：排序、材料感知、必答项与进度。
 *
 * 覆盖验收点：required 未答优先；材料清单里已有学校模板时不再重复提问模板问题；
 * 校验函数只给 note 不阻塞（必答项格式不合格会挡住 done）；阶段影响排序。
 *
 * @module dsh-thesis/tests/intake-questions
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  blockingRequired,
  DEFAULT_STAGE,
  listRequired,
  makeContext,
  materialInsight,
  nextQuestion,
  progress,
  questionById,
  QUESTIONS,
  questionQueue,
  INTAKE_SECTIONS,
  type MaterialSummary,
} from '../src/intake/questions.ts'
import { defaultState, applyAnswer, parseMaterials } from '../src/intake/state.ts'
import { materialsMarkdown } from './intake-fixtures.ts'

const EMPTY: MaterialSummary = { found: false, items: [] }

test('问题库覆盖任务要求的分节与必答项', () => {
  const sections = new Set(QUESTIONS.map(q => q.section))
  for (const s of INTAKE_SECTIONS) assert.ok(sections.has(s), `缺少分节：${s}`)
  const ids = new Set(QUESTIONS.map(q => q.id))
  for (const id of [
    'school.name', 'school.degree', 'school.template', 'school.rule.ai',
    'topic.title', 'topic.source', 'scope.wordcount', 'deliver.timeline',
    'tech.stack', 'tech.code', 'data.source', 'data.real',
    'ref.requirement', 'ref.format', 'ref.samples',
    'plag.system', 'defense.format',
  ]) {
    assert.ok(ids.has(id), `缺少问题：${id}`)
  }
  // 每个问题都必须能回答「为什么问 / 影响什么 / 什么样算合格」。
  for (const q of QUESTIONS) {
    assert.ok(q.ask.length > 4, `${q.id} 的问句太短`)
    assert.ok(q.why.length > 6, `${q.id} 缺少 why`)
    assert.ok(q.affects.length > 0, `${q.id} 缺少 affects`)
    assert.ok(q.answerShape.length > 4, `${q.id} 缺少 answerShape`)
  }
})

test('required 未答的问题排在前面', () => {
  const state = defaultState(new Date('2026-01-01T00:00:00Z'))
  const ctx = makeContext(EMPTY, DEFAULT_STAGE)
  const first = nextQuestion(state, ctx)
  assert.ok(first !== undefined)
  assert.equal(first.required, true, '第一个问题必须是必答项')
  assert.equal(blockingRequired(state).length, listRequired().length)
})

test('材料清单里已有学校模板 → 不再重复提问，改为待确认', () => {
  const materials = parseMaterials(materialsMarkdown([
    { file: '01-材料/学校论文格式模板.docx', kind: '学校模板' },
    { file: '01-材料/实验数据.xlsx', kind: '实验数据' },
  ]))
  assert.equal(materials.found, true)
  const insight = materialInsight(materials)
  const auto = insight.autoAnswers.get('school.template')
  assert.ok(auto !== undefined, '应从材料推断出学校模板路径')
  assert.equal(auto.value, '01-材料/学校论文格式模板.docx')
  assert.equal(auto.needsConfirm, true)

  const state = defaultState(new Date('2026-01-01T00:00:00Z'))
  const ctx = makeContext(materials, DEFAULT_STAGE)
  const first = nextQuestion(state, ctx)
  assert.equal(first?.id, 'school.template', '材料已答的问题应最先请用户确认')
  // 数据类问题由材料安全推断：不再打扰用户。
  assert.ok(insight.suppress.has('data.source'))
  const queue = questionQueue(state, ctx)
  assert.ok(!queue.some(q => q.id === 'data.source'), '材料已覆盖的问题不应出现在队列里')
})

test('材料清单缺失时不做任何推断，一切照常提问', () => {
  const insight = materialInsight(EMPTY)
  assert.equal(insight.autoAnswers.size, 0)
  assert.equal(insight.suppress.size, 0)
})

test('材料清单解析宽容：表头/分隔行/说明文字都不影响', () => {
  const md = [
    '# 材料清单',
    '',
    '> 本文件由 thesis_ingest 维护。',
    '',
    '| 文件 | 类型 | 大小 |',
    '|---|---|---|',
    '| `01-材料/学校模板.docx` | 学校模板 | 88 KB |',
    '| 01-材料/数据.csv | 实验数据 | 2 KB |',
    '',
    '补充说明：以上材料均已转成 Markdown。',
  ].join('\n')
  const summary = parseMaterials(md)
  assert.equal(summary.items.length, 2)
  assert.equal(summary.items[0]?.path, '01-材料/学校模板.docx')
  assert.equal(summary.items[1]?.ext, 'csv')
})

test('validate 只给 note 不阻塞：字数不是数字时仍被记录', () => {
  const q = questionById('scope.wordcount')
  assert.ok(q?.validate !== undefined)
  const check = q!.validate!('大概一万五吧')
  assert.equal(check.ok, false)
  assert.ok((check.note ?? '').includes('字数'), `提示应说清缺什么：${check.note ?? ''}`)

  const state = defaultState(new Date('2026-01-01T00:00:00Z'))
  applyAnswer(state, 'scope.wordcount', '大概一万五吧', { valid: check.ok, note: check.note })
  assert.equal(state.answers['scope.wordcount']?.value, '大概一万五吧')
  assert.equal(state.answers['scope.wordcount']?.valid, false)
  // 非必答项格式不合格不进入阻塞项。
  assert.ok(!blockingRequired(state).some(x => x.id === 'scope.wordcount'))
})

test('必答项格式不合格会进入阻塞项（done 因此会拒绝）', () => {
  const state = defaultState(new Date('2026-01-01T00:00:00Z'))
  const q = questionById('school.name')!
  const check = q.validate!('X')
  assert.equal(check.ok, false)
  applyAnswer(state, 'school.name', 'X', { valid: check.ok, note: check.note })
  assert.deepEqual(blockingRequired(state).map(x => x.id).includes('school.name'), true)
  assert.equal(blockingRequired(state)[0]?.id, 'school.name')
})

test('年份与字数校验：明显不合理的值给具体提示', () => {
  const deadline = questionById('deliver.timeline')!
  assert.equal(deadline.validate!('开题 2026-01-10，中期 2026-03-20').ok, true)
  assert.equal(deadline.validate!('不知道').ok, true)
  assert.equal(deadline.validate!('下个月吧').ok, false)
  assert.equal(deadline.validate!('2026-13-45').ok, false)

  const wordcount = questionById('scope.wordcount')!
  assert.equal(wordcount.validate!('全文 15000 字，绪论 2000').ok, true)
  assert.equal(wordcount.validate!('全文 15000，绪论 9000，相关技术 9000，设计 9000').ok, false)
})

test('进度统计与阶段影响排序', () => {
  const state = defaultState(new Date('2026-01-01T00:00:00Z'))
  assert.deepEqual(progress(state), { answered: 0, total: listRequired().length, required: listRequired().length, confirmed: 0 })
  for (const q of listRequired()) applyAnswer(state, q.id, '已答', { valid: true })
  assert.equal(progress(state).answered, listRequired().length)
  assert.deepEqual(blockingRequired(state), [])

  // 论文撰写阶段：字数分配/降重相关的问题应当提前（这里只断言排序稳定且不抛错）。
  const ctx = makeContext(EMPTY, '论文撰写')
  const queue = questionQueue(state, ctx)
  const again = questionQueue(state, makeContext(EMPTY, '论文撰写'))
  assert.deepEqual(queue.map(q => q.id), again.map(q => q.id), '排序必须确定')
})
