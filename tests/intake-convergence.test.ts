/**
 * 跨模块契约测试：**追问收敛后，入口闸门必须放行**。
 *
 * `intake` 渲染规格时用的字面量（「未知（需补）」等）与 `intake/gate-rules.ts` 判定
 * 「规格没立稳」用的字面量是同一套契约，但它们写在两个文件里。一旦有人改了措辞，
 * 后果是**闸门永远认为规格没立稳**——用户每次说「帮我写第三章」都被要求重新追问，
 * 而单模块测试各自全绿。所以这里走一遍真实收敛流程，再用闸门判定器验收。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { judgeSpec } from '../src/intake/gate-rules.ts'
import { EMPTY_MATERIALS, blockingRequired, listRequired, makeContext } from '../src/intake/questions.ts'
import { checkAnswer, renderSpec } from '../src/intake/spec.ts'
import { applyAnswer, defaultState, markAsked } from '../src/intake/state.ts'

const NOW = new Date('2026-01-01T00:00:00Z')

/** 必答项的合格答案（按各自 `validate` 的形态给出；非必答项用占位）。 */
const ANSWERS: Readonly<Record<string, string>> = {
  'school.name': '示例大学 计算机学院 软件工程',
  'school.degree': '本科（工学学士）',
  'school.template': '没有',
  'school.rule.ai': '有：正文须由本人独立完成，AI 仅可用于辅助查资料与代码调试。',
  'topic.title': '基于示例数据的校园服务系统设计与实现',
  'deliver.timeline': '开题 2026-01-10，中期 2026-03-20，查重 2026-05-01，答辩 2026-05-20',
  'data.real': '有：05-实验测试/结果/result.csv',
  'ref.format': 'GB/T 7714-2015 顺序编码制（上标数字）',
}

/** 模拟工具的执行层：逐题作答（含质检），与 `thesis_intake action=answer` 同一路径。 */
function answerAll(state: ReturnType<typeof defaultState>, ids: readonly string[]): void {
  for (const id of ids) {
    const question = listRequired().find(item => item.id === id) ?? null
    const answer = ANSWERS[id] ?? '示例答案（用于契约测试）'
    markAsked(state, id, NOW)
    const check = question === null ? { ok: true } : checkAnswer(question, answer)
    applyAnswer(state, id, answer, {
      source: 'user',
      confirmed: true,
      valid: check.ok,
      note: check.note,
      now: NOW,
    })
  }
}

test('必答项清单与闸门契约覆盖一致（新增必答项必须同时给出合格答案样例）', () => {
  const required = listRequired().map(question => question.id).sort()
  const covered = Object.keys(ANSWERS).sort()
  assert.deepEqual(covered, required, 'ANSWERS 必须覆盖全部必答项，否则本测试无法验证收敛')
})

test('未作答时：规格被闸门判为未立稳（blocked）', () => {
  const state = defaultState(NOW, '00-管理/意图规格.md')
  const context = makeContext(EMPTY_MATERIALS, '开题前')
  const spec = renderSpec(state, context)
  const status = judgeSpec(spec)
  assert.equal(status.kind, 'blocked', `未作答的规格必须被闸门拦住，实际 ${JSON.stringify(status)}`)
})

test('全部必答项答完（含质检通过）后：规格被闸门判为就绪（ready）', () => {
  const state = defaultState(NOW, '00-管理/意图规格.md')
  const context = makeContext(EMPTY_MATERIALS, '开题前')
  answerAll(state, listRequired().map(question => question.id))

  assert.deepEqual(blockingRequired(state), [], '模块自己的判断：不应再有阻塞的必答项')

  const spec = renderSpec(state, context)
  assert.ok(spec.includes('用户回答'), '规格里应标注来源为用户回答')
  assert.ok(!spec.includes('未知（需补）'), '收敛后的规格不得再出现闸门关键词「未知（需补）」')
  const status = judgeSpec(spec)
  assert.equal(status.kind, 'ready', `规格应就绪，实际 ${JSON.stringify(status)}`)
})

test('幂等：同一状态渲染两次结果一致（闸门不会因为渲染抖动而反复拦截）', () => {
  const state = defaultState(NOW, '00-管理/意图规格.md')
  const context = makeContext(EMPTY_MATERIALS, '开题前')
  answerAll(state, listRequired().map(question => question.id))
  assert.equal(renderSpec(state, context), renderSpec(state, context))
})

test('不合格的必答答案会重新变成阻塞（闸门再次拦截）', () => {
  const state = defaultState(NOW, '00-管理/意图规格.md')
  const context = makeContext(EMPTY_MATERIALS, '开题前')
  answerAll(state, listRequired().map(question => question.id))
  assert.equal(judgeSpec(renderSpec(state, context)).kind, 'ready')

  // 重答一个必答项，但格式不合格（学校名太短）。
  const question = listRequired().find(item => item.id === 'school.name')!
  const bad = checkAnswer(question, '啊')
  assert.equal(bad.ok, false, '样例答案应被判为不合格')
  applyAnswer(state, 'school.name', '啊', { source: 'user', confirmed: true, valid: false, note: bad.note, now: NOW })
  assert.equal(judgeSpec(renderSpec(state, context)).kind, 'blocked', '格式不合格的必答项必须让规格回到未立稳')
})
