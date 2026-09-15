/**
 * `learn_*` 模型工具测试：注册、状态读取、下一步负载、经校验的状态改动，
 * 以及 check_gate 的验证门闭环。
 *
 * @module dsh-thesis/tests/codewalk-tools
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { CodeWalkthroughOptions } from '../src/config.ts'
import type { AiLearningEngine } from '../src/codewalk/engine.ts'
import { registerCodewalk } from '../src/codewalk/register.ts'
import type { ToolDefinitionShape, ToolRunContextShape } from '../src/codewalk/host-types.ts'
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
  exec(tool: ToolDefinitionShape, args?: unknown): Promise<unknown>
}

function makeHarness(): Harness {
  const ctx = new FakeContext()
  registerCodewalk(asContext(ctx), OPTIONS)
  const engine = ctx.get('paperCodeWalkthrough') as AiLearningEngine
  const exec = (tool: ToolDefinitionShape, args: unknown = {}): Promise<unknown> => {
    const runCtx: ToolRunContextShape = {
      callId: 'call-1',
      agent: { session: { header: { cwd: CWD } } },
      signal: new AbortController().signal,
    }
    return tool.execute(args, runCtx)
  }
  return { ctx, engine, exec }
}

async function seedState(engine: AiLearningEngine): Promise<void> {
  const state = await engine.create(CWD, {
    origin: { path: '/src/project', language: 'go' },
    scope: { level: 'beginner' },
  })
  await engine.save(CWD, state)
}

describe('工具注册', () => {
  it('组合了注册表时注册 defense_code_status / defense_code_next / defense_code_update', () => {
    const { ctx } = makeHarness()
    assert.deepEqual(ctx.tools.names(), ['defense_code_status', 'defense_code_next', 'defense_code_update'])
  })

  it('没有工具注册表时跳过注册', () => {
    const ctx = new FakeContext({ tools: false })
    registerCodewalk(asContext(ctx), OPTIONS)
    assert.equal(ctx.get('tools'), undefined)
    assert.equal(ctx.get('paperCodeWalkthrough') === undefined, false)
  })

  it('工具描述为简体中文', () => {
    const { ctx } = makeHarness()
    assert.match(ctx.tools.tool('defense_code_status').description, /代码演练/)
    assert.match(ctx.tools.tool('defense_code_update').description, /状态/)
  })
})

describe('defense_code_status', () => {
  it('描述当前状态', async () => {
    const harness = makeHarness()
    await seedState(harness.engine)
    const result = await harness.exec(harness.ctx.tools.tool('defense_code_status'))
    assert.match(String(result), /phase: analyzing/)
  })

  it('没有状态时拒绝', async () => {
    const harness = makeHarness()
    // 这里的拒绝是普通 Error（不是 LearningError），因此直接断言文案。
    await assert.rejects(harness.exec(harness.ctx.tools.tool('defense_code_status')), /没有代码演练状态/)
  })

  it('没有 agent 附着时拒绝', async () => {
    const harness = makeHarness()
    await seedState(harness.engine)
    const tool = harness.ctx.tools.tool('defense_code_status')
    const bare: ToolRunContextShape = { callId: 'c', signal: new AbortController().signal }
    await assert.rejects(tool.execute({}, bare), /会话 cwd/)
  })
})

describe('defense_code_next', () => {
  it('返回当前里程碑的 todo、验证门与问题', async () => {
    const harness = makeHarness()
    await seedState(harness.engine)
    const state = (await harness.engine.load(CWD))!
    harness.engine.upsertTodo(state, {
      id: 't1',
      where: 'a.go f',
      what: 'writes a task',
      steps: ['one'],
      difficulty: 2,
      status: 'done',
    })
    harness.engine.upsertMilestone(state, {
      id: 'm1',
      title: 'Task CRUD',
      todos: ['t1'],
      questions: [{ ask: 'why etcd?', expected: ['lease safety'], hints: ['lease'], status: 'unasked', hintLevel: 0 }],
      status: 'pending',
    })
    harness.engine.advancePhase(state, 'skeletonizing')
    harness.engine.advancePhase(state, 'learning')
    await harness.engine.save(CWD, state)

    const payload = (await harness.exec(harness.ctx.tools.tool('defense_code_next'))) as Record<string, unknown>
    const current = payload.current as Record<string, unknown>
    assert.equal(current.id, 'm1')
    assert.deepEqual(current.gate, { build: ['go', 'build', './...'] })
    const questions = current.questions as Array<Record<string, unknown>>
    assert.equal(questions[0]!.ask, 'why etcd?')
    assert.deepEqual(questions[0]!.expected, ['lease safety'])
    assert.equal(payload.nextMilestone, null)
  })

  it('analyzing 阶段给出中文引导', async () => {
    const harness = makeHarness()
    await seedState(harness.engine)
    const payload = (await harness.exec(harness.ctx.tools.tool('defense_code_next'))) as Record<string, unknown>
    assert.equal(payload.current, null)
    assert.match(String(payload.guidance), /分析原始项目/)
  })
})

describe('defense_code_update', () => {
  it('登记 todo 与里程碑并立即落盘', async () => {
    const harness = makeHarness()
    await seedState(harness.engine)
    const update = harness.ctx.tools.tool('defense_code_update')

    const todoResult = await harness.exec(update, {
      action: 'upsert_todo',
      todo: { id: 't1', where: 'a.go f', what: 'writes a task', steps: ['one'], difficulty: 2, status: 'pending' },
    })
    assert.match(String(todoResult), /已登记 todo t1/)

    const milestoneResult = await harness.exec(update, {
      action: 'upsert_milestone',
      milestone: { id: 'm1', title: 'Task CRUD', todos: ['t1'], questions: [], status: 'pending' },
    })
    assert.match(String(milestoneResult), /已登记里程碑 m1/)

    const state = await harness.engine.load(CWD)
    assert.deepEqual(state?.todos.map((todo) => todo.id), ['t1'])
    assert.deepEqual(state?.milestones.map((milestone) => milestone.id), ['m1'])
  })

  it('推进阶段并启动第一个里程碑', async () => {
    const harness = makeHarness()
    await seedState(harness.engine)
    const update = harness.ctx.tools.tool('defense_code_update')
    await harness.exec(update, {
      action: 'upsert_todo',
      todo: { id: 't1', where: 'a.go f', what: 'writes a task', steps: ['one'], difficulty: 1, status: 'pending' },
    })
    await harness.exec(update, {
      action: 'upsert_milestone',
      milestone: { id: 'm1', title: 'M1', todos: ['t1'], questions: [], status: 'pending' },
    })
    await harness.exec(update, { action: 'advance_phase', phase: 'skeletonizing' })
    const result = await harness.exec(update, { action: 'advance_phase', phase: 'learning' })
    assert.match(String(result), /当前里程碑：m1/)
    const state = await harness.engine.load(CWD)
    assert.equal(state?.phase, 'learning')
    assert.equal(state?.milestones[0]!.status, 'in_progress')
  })

  it('非法迁移经引擎拒绝', async () => {
    const harness = makeHarness()
    await seedState(harness.engine)
    await assert.rejects(
      harness.exec(harness.ctx.tools.tool('defense_code_update'), { action: 'advance_phase', phase: 'complete' }),
      /不能从阶段/,
    )
  })

  it('没有命令面时也能创建新训练', async () => {
    const harness = makeHarness()
    const update = harness.ctx.tools.tool('defense_code_update')
    const result = await harness.exec(update, {
      action: 'create',
      originPath: '/src/project',
      language: 'go',
      level: 'advanced',
      module: 'pkg',
    })
    assert.match(String(result), /已为 \/src\/project 创建代码演练（go，advanced）/)
    const state = await harness.engine.load(CWD)
    assert.equal(state?.phase, 'analyzing')
    assert.deepEqual(state?.scope, { level: 'advanced', module: 'pkg' })
    await assert.rejects(harness.exec(update, { action: 'create' }), /需要 "originPath"/)
  })

  it('驱动问答阶梯：提问、提示、评分、重提', async () => {
    const harness = makeHarness()
    await seedState(harness.engine)
    const update = harness.ctx.tools.tool('defense_code_update')
    await harness.exec(update, {
      action: 'upsert_todo',
      todo: { id: 't1', where: 'a.go f', what: 'writes a task', steps: ['one'], difficulty: 1, status: 'done' },
    })
    await harness.exec(update, {
      action: 'upsert_milestone',
      milestone: {
        id: 'm1',
        title: 'M1',
        todos: ['t1'],
        questions: [{ ask: 'why etcd?', expected: ['leases'], hints: ['think crashes'], status: 'unasked', hintLevel: 0 }],
        status: 'pending',
      },
    })

    await assert.rejects(
      harness.exec(update, { action: 'give_hint', milestoneId: 'm1', questionIndex: 0 }),
      /必须先提出/,
    )
    await harness.exec(update, { action: 'ask_question', milestoneId: 'm1', questionIndex: 0 })
    const hintResult = await harness.exec(update, { action: 'give_hint', milestoneId: 'm1', questionIndex: 0 })
    assert.match(String(hintResult), /think crashes/)

    await harness.exec(update, { action: 'assess_answer', milestoneId: 'm1', questionIndex: 0, passed: false, note: 'surface' })
    const state = await harness.engine.load(CWD)
    assert.equal(state?.milestones[0]!.questions[0]!.status, 'failed')
    assert.equal(state?.milestones[0]!.questions[0]!.note, 'surface')
  })

  it('提示阶梯用尽时提示需要公布答案并要求复述', async () => {
    const harness = makeHarness()
    await seedState(harness.engine)
    const update = harness.ctx.tools.tool('defense_code_update')
    await harness.exec(update, {
      action: 'upsert_todo',
      todo: { id: 't1', where: 'a.go f', what: 'w', steps: ['one'], difficulty: 1, status: 'done' },
    })
    await harness.exec(update, {
      action: 'upsert_milestone',
      milestone: {
        id: 'm1',
        title: 'M1',
        todos: ['t1'],
        questions: [{ ask: 'q', expected: ['p'], hints: ['h'], status: 'unasked', hintLevel: 0 }],
        status: 'pending',
      },
    })
    await harness.exec(update, { action: 'ask_question', milestoneId: 'm1', questionIndex: 0 })
    await harness.exec(update, { action: 'give_hint', milestoneId: 'm1', questionIndex: 0 })
    const exhausted = await harness.exec(update, { action: 'give_hint', milestoneId: 'm1', questionIndex: 0 })
    assert.match(String(exhausted), /提示阶梯已用尽/)
  })

  it('check_gate 跑验证门并验证里程碑', async () => {
    const harness = makeHarness()
    await seedState(harness.engine)
    const update = harness.ctx.tools.tool('defense_code_update')
    await harness.exec(update, {
      action: 'upsert_todo',
      todo: { id: 't1', where: 'a.go f', what: 'writes a task', steps: ['one'], difficulty: 2, status: 'done' },
    })
    await harness.exec(update, {
      action: 'upsert_milestone',
      milestone: { id: 'm1', title: 'M1', todos: ['t1'], questions: [], status: 'pending' },
    })
    await harness.exec(update, { action: 'advance_phase', phase: 'skeletonizing' })
    await harness.exec(update, { action: 'advance_phase', phase: 'learning' })

    harness.ctx.shell.exitCode = 1
    harness.ctx.shell.stderrText = 'undefined: x'
    const failed = await harness.exec(update, { action: 'check_gate' })
    assert.match(String(failed), /已标记为 failed/)
    assert.match(String(failed), /undefined: x/)

    harness.ctx.shell.exitCode = 0
    const verified = await harness.exec(update, { action: 'check_gate' })
    assert.match(String(verified), /已验证/)
    assert.match(String(verified), /完成/)
    const state = await harness.engine.load(CWD)
    assert.equal(state?.records.length, 2)
    assert.equal(harness.ctx.shell.calls[0]?.command, 'go build ./...')
    assert.equal(harness.ctx.shell.calls[0]?.workdir, CWD)
  })

  it('有问题未通过时 check_gate 报告剩余问题数', async () => {
    const harness = makeHarness()
    await seedState(harness.engine)
    const update = harness.ctx.tools.tool('defense_code_update')
    await harness.exec(update, {
      action: 'upsert_todo',
      todo: { id: 't1', where: 'a.go f', what: 'w', steps: ['one'], difficulty: 1, status: 'done' },
    })
    await harness.exec(update, {
      action: 'upsert_milestone',
      milestone: {
        id: 'm1',
        title: 'M1',
        todos: ['t1'],
        questions: [{ ask: 'q', expected: ['p'], hints: [], status: 'unasked', hintLevel: 0 }],
        status: 'pending',
      },
    })
    await harness.exec(update, { action: 'advance_phase', phase: 'skeletonizing' })
    await harness.exec(update, { action: 'advance_phase', phase: 'learning' })
    const result = await harness.exec(update, { action: 'check_gate' })
    assert.match(String(result), /仍有 1 个问题未通过/)
  })

  it('没有可检查的里程碑时 check_gate 拒绝', async () => {
    const harness = makeHarness()
    await seedState(harness.engine)
    await assert.rejects(harness.exec(harness.ctx.tools.tool('defense_code_update'), { action: 'check_gate' }), /没有可检查的对象/)
  })

  it('未知动作与缺字段都给出中文错误', async () => {
    const harness = makeHarness()
    await seedState(harness.engine)
    const update = harness.ctx.tools.tool('defense_code_update')
    await assert.rejects(harness.exec(update, { action: 'nope' }), /未知的更新动作/)
    await assert.rejects(harness.exec(update, { action: 'upsert_todo' }), /需要 "todo"/)
    await assert.rejects(harness.exec(update, { action: 'set_todo_status', todoId: 't1' }), /需要 "status"/)
  })
})
