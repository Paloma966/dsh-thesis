/**
 * pre-step 注入测试：只在存在进行中的演练时注入进度卡片，且状态未变化时不重复
 * 注入（避免每个 step 都烧 token），训练完成后彻底停止注入。
 *
 * @module dsh-thesis/tests/codewalk-prestep
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { CodeWalkthroughOptions } from '../src/config.ts'
import type { AiLearningEngine } from '../src/codewalk/engine.ts'
import { buildProgressMessage } from '../src/codewalk/prestep.ts'
import { registerCodewalk } from '../src/codewalk/register.ts'
import type { PreStepDecisionShape, PreStepPayloadShape } from '../src/codewalk/host-types.ts'
import { asContext, FakeContext } from './codewalk-fixtures.ts'

const CWD = '/work'

const OPTIONS: CodeWalkthroughOptions = {
  stateDir: '.paper',
  gates: { go: { build: ['go', 'build', './...'] } },
  maxCapturedOutput: 8000,
}

interface Harness {
  readonly ctx: FakeContext
  readonly engine: AiLearningEngine
  step(): Promise<PreStepDecisionShape>
}

function makeHarness(): Harness {
  const ctx = new FakeContext()
  registerCodewalk(asContext(ctx), OPTIONS)
  const engine = ctx.get('paperCodeWalkthrough') as AiLearningEngine
  const agent = { session: { header: { cwd: CWD } } }
  const step = async (): Promise<PreStepDecisionShape> => {
    const payload: PreStepPayloadShape = {
      agent,
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    }
    return await ctx.dispatchPreStep(payload, async () => ({ kind: 'enter', messages: [] }))
  }
  return { ctx, engine, step }
}

/** 让 `Date.now()` 前进，保证下一次 save 的 updatedAt 必然变化。 */
async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5))
}

async function seed(harness: Harness) {
  return await harness.engine.create(CWD, {
    origin: { path: '/src/project', language: 'go' },
    scope: { level: 'beginner' },
  })
}

describe('pre-step 进度注入', () => {
  it('没有状态时不注入任何东西', async () => {
    const harness = makeHarness()
    const decision = await harness.step()
    assert.equal(decision.kind, 'enter')
    assert.equal(decision.messages.length, 0)
  })

  it('有进行中的演练时注入一张进度卡片', async () => {
    const harness = makeHarness()
    await seed(harness)
    const decision = await harness.step()
    assert.equal(decision.messages.length, 1)
    const message = decision.messages[0]!
    assert.equal(message.role, 'user')
    assert.match(message.content[0]!.text, /代码演练/)
    assert.equal(message.source.plugin, 'dsh-thesis')
    assert.equal(message.source.sections[0]!.name, '代码演练进度')
  })

  it('状态未变化时不重复注入，状态变化后重新注入', async () => {
    const harness = makeHarness()
    const state = await seed(harness)

    const first = await harness.step()
    assert.equal(first.messages.length, 1)
    const second = await harness.step()
    assert.equal(second.messages.length, 0)

    await tick()
    state.phase = 'skeletonizing'
    await harness.engine.save(CWD, state)
    const third = await harness.step()
    assert.equal(third.messages.length, 1)
  })

  it('训练完成后不再注入', async () => {
    const harness = makeHarness()
    const state = await seed(harness)
    state.phase = 'complete'
    await harness.engine.save(CWD, state)
    const decision = await harness.step()
    assert.equal(decision.messages.length, 0)
  })

  it('上游拒绝时不注入', async () => {
    const harness = makeHarness()
    await seed(harness)
    const agent = { session: { header: { cwd: CWD } } }
    const payload: PreStepPayloadShape = { agent, turn: 1, step: 1, signal: new AbortController().signal }
    const decision = await harness.ctx.dispatchPreStep(payload, async () => ({ kind: 'reject', messages: [] }))
    assert.equal(decision.kind, 'reject')
    assert.equal(decision.messages.length, 0)
  })

  it('signal 已中止时不注入', async () => {
    const harness = makeHarness()
    await seed(harness)
    const controller = new AbortController()
    controller.abort()
    const payload: PreStepPayloadShape = {
      agent: { session: { header: { cwd: CWD } } },
      turn: 1,
      step: 1,
      signal: controller.signal,
    }
    const decision = await harness.ctx.dispatchPreStep(payload, async () => ({ kind: 'enter', messages: [] }))
    assert.equal(decision.messages.length, 0)
  })

  it('状态损坏时静默放行而不是报错', async () => {
    const harness = makeHarness()
    await seed(harness)
    harness.ctx.fs.files.set(`${CWD}/.paper/state.json`, 'not json')
    const decision = await harness.step()
    assert.equal(decision.kind, 'enter')
    assert.equal(decision.messages.length, 0)
  })

  it('保留上游 decision 里已有的消息', async () => {
    const harness = makeHarness()
    await seed(harness)
    const payload: PreStepPayloadShape = {
      agent: { session: { header: { cwd: CWD } } },
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    }
    const existing = buildProgressMessage({} as never)
    const decision = await harness.ctx.dispatchPreStep(payload, async () => ({
      kind: 'enter',
      messages: [{ ...existing, id: 'upstream' }],
    }))
    assert.equal(decision.messages.length, 2)
    assert.equal(decision.messages[0]!.id, 'upstream')
  })
})
