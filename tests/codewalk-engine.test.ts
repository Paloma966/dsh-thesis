/**
 * 代码演练引擎状态机测试：阶段推进、todo 迁移、里程碑冻结、追问评分
 * 阶梯、验证门记录与持久化。
 *
 * 断言策略：非法迁移优先断言稳定的 `LearningError.code`（而不是中文文案），
 * 文案断言只保留极少数稳定片段。
 *
 * @module dsh-thesis/tests/codewalk-engine
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { CodeWalkthroughOptions } from '../src/config.ts'
import { AiLearningEngine } from '../src/codewalk/engine.ts'
import { registerCodewalk } from '../src/codewalk/register.ts'
import type { CreateStateInput, GateRecord, LearningState, Milestone, Question, Todo } from '../src/codewalk/types.ts'
import { asContext, FakeContext, rejectsWithCode, throwsWithCode } from './codewalk-fixtures.ts'

const ORIGIN: CreateStateInput['origin'] = { path: '/src/project', language: 'go' }
const SCOPE: CreateStateInput['scope'] = { level: 'beginner' }

interface Harness {
  readonly ctx: FakeContext
  readonly engine: AiLearningEngine
}

function makeEngine(overrides: Partial<CodeWalkthroughOptions> = {}): Harness {
  const ctx = new FakeContext()
  const options: CodeWalkthroughOptions = {
    stateDir: '.paper',
    gates: { go: { build: ['go', 'build', './...'] } },
    maxCapturedOutput: 8000,
    ...overrides,
  }
  registerCodewalk(asContext(ctx), options)
  const engine = ctx.get('paperCodeWalkthrough') as AiLearningEngine
  return { ctx, engine }
}

function makeTodo(id: string, status: Todo['status'] = 'pending'): Todo {
  return {
    id,
    where: `internal/store/${id}.go ${id}`,
    what: `persists ${id}`,
    steps: ['marshal', 'write'],
    hint: 'use a lease',
    difficulty: 2,
    status,
  }
}

function makeQuestion(ask: string, status: Question['status'] = 'unasked'): Question {
  return { ask, expected: ['point one', 'point two'], hints: ['hint one', 'hint two'], status, hintLevel: 0 }
}

function makeMilestone(id: string, todoIds: string[], questions: Question[] = []): Milestone {
  return { id, title: `milestone ${id}`, todos: todoIds, questions, status: 'pending' }
}

function makeState(overrides: Partial<LearningState> = {}): LearningState {
  return {
    schemaVersion: 1,
    phase: 'analyzing',
    origin: { ...ORIGIN },
    scope: { ...SCOPE },
    milestones: [],
    todos: [],
    gates: { go: { build: ['go', 'build', './...'] } },
    records: [],
    updatedAt: 0,
    ...overrides,
  }
}

function gateInput(
  exitCode: number,
  stdout: string,
): Omit<GateRecord, 'milestone' | 'at'> {
  return { command: ['go', 'build', './...'], exitCode, stdout, stderr: '', durationMs: 42 }
}

describe('阶段状态机', () => {
  it('沿阶梯单向前进，并拒绝跳跃', () => {
    const { engine } = makeEngine()
    const state = makeState()
    engine.advancePhase(state, 'skeletonizing')
    assert.equal(state.phase, 'skeletonizing')
    throwsWithCode(() => engine.advancePhase(state, 'complete'), 'ILLEGAL_TRANSITION')
    throwsWithCode(() => engine.advancePhase(state, 'analyzing'), 'ILLEGAL_TRANSITION')
  })

  it('没有里程碑时拒绝进入 learning', () => {
    const { engine } = makeEngine()
    const state = makeState({ phase: 'skeletonizing' })
    assert.match(throwsWithCode(() => engine.advancePhase(state, 'learning'), 'ILLEGAL_TRANSITION').message, /里程碑/)
  })

  it('有空里程碑时拒绝进入 learning；合法时启动第一个里程碑', () => {
    const { engine } = makeEngine()
    const empty = makeState({ phase: 'skeletonizing', milestones: [makeMilestone('m1', [])] })
    assert.match(throwsWithCode(() => engine.advancePhase(empty, 'learning'), 'ILLEGAL_TRANSITION').message, /todo/)

    const state = makeState({
      phase: 'skeletonizing',
      todos: [makeTodo('t1')],
      milestones: [makeMilestone('m1', ['t1'])],
    })
    engine.advancePhase(state, 'learning')
    assert.equal(state.phase, 'learning')
    assert.equal(state.milestones[0]!.status, 'in_progress')
  })

  it('有未关闭里程碑时拒绝 complete', () => {
    const { engine } = makeEngine()
    const state = makeState({
      phase: 'learning',
      todos: [makeTodo('t1')],
      milestones: [makeMilestone('m1', ['t1'], [makeQuestion('q1')])],
    })
    state.milestones[0]!.status = 'in_progress'
    assert.match(throwsWithCode(() => engine.advancePhase(state, 'complete'), 'ILLEGAL_TRANSITION').message, /未关闭/)
  })
})

describe('todo 状态机', () => {
  it('pending → in_progress → done，并允许返工', () => {
    const { engine } = makeEngine()
    const state = makeState({ todos: [makeTodo('t1')] })
    engine.setTodoStatus(state, 't1', 'in_progress')
    assert.equal(state.todos[0]!.status, 'in_progress')
    engine.setTodoStatus(state, 't1', 'done')
    assert.equal(state.todos[0]!.status, 'done')
    engine.setTodoStatus(state, 't1', 'in_progress')
    assert.equal(state.todos[0]!.status, 'in_progress')
  })

  it('拒绝非法迁移与未知 id', () => {
    const { engine } = makeEngine()
    const state = makeState({ todos: [makeTodo('t1', 'done')] })
    throwsWithCode(() => engine.setTodoStatus(state, 't1', 'pending'), 'ILLEGAL_TRANSITION')
    throwsWithCode(() => engine.setTodoStatus(state, 'nope', 'done'), 'TODO_UNKNOWN')
  })

  it('冻结被 verified 里程碑引用的 todo', () => {
    const { engine } = makeEngine()
    const state = makeState({
      phase: 'learning',
      todos: [makeTodo('t1', 'done')],
      milestones: [{ ...makeMilestone('m1', ['t1']), status: 'verified' }],
    })
    assert.match(
      throwsWithCode(() => engine.upsertTodo(state, { ...makeTodo('t1', 'done'), what: 'changed' }), 'ILLEGAL_TRANSITION')
        .message,
      /冻结/,
    )
  })

  it('拒绝非法难度与非法状态', () => {
    const { engine } = makeEngine()
    const state = makeState()
    throwsWithCode(
      () => engine.upsertTodo(state, { ...makeTodo('t1'), difficulty: 9 as unknown as Todo['difficulty'] }),
      'ILLEGAL_TRANSITION',
    )
    throwsWithCode(
      () => engine.upsertTodo(state, { ...makeTodo('t1'), status: 'nope' as unknown as Todo['status'] }),
      'ILLEGAL_TRANSITION',
    )
  })
})

describe('里程碑状态机', () => {
  it('拒绝未知 todo 引用', () => {
    const { engine } = makeEngine()
    const state = makeState()
    throwsWithCode(() => engine.upsertMilestone(state, makeMilestone('m1', ['ghost'])), 'TODO_UNKNOWN')
  })

  it('拒绝没有提问文本的问题', () => {
    const { engine } = makeEngine()
    const state = makeState({ todos: [makeTodo('t1')] })
    throwsWithCode(
      () => engine.upsertMilestone(state, makeMilestone('m1', ['t1'], [makeQuestion('  ')])),
      'ILLEGAL_TRANSITION',
    )
  })

  it('冻结 verified 里程碑，内容编辑时保留原有状态', () => {
    const { engine } = makeEngine()
    const state = makeState({
      todos: [makeTodo('t1')],
      milestones: [{ ...makeMilestone('m1', ['t1']), status: 'verified' }],
    })
    assert.match(
      throwsWithCode(() => engine.upsertMilestone(state, makeMilestone('m1', ['t1'])), 'ILLEGAL_TRANSITION').message,
      /冻结/,
    )

    const open = makeState({
      phase: 'learning',
      todos: [makeTodo('t1')],
      milestones: [{ ...makeMilestone('m1', ['t1']), status: 'failed' }],
    })
    engine.upsertMilestone(open, { ...makeMilestone('m1', ['t1']), title: 'renamed' })
    assert.equal(open.milestones[0]!.title, 'renamed')
    assert.equal(open.milestones[0]!.status, 'failed')
  })

  it('只有 failed 里程碑能重开', () => {
    const { engine } = makeEngine()
    const state = makeState({
      phase: 'learning',
      todos: [makeTodo('t1')],
      milestones: [{ ...makeMilestone('m1', ['t1']), status: 'in_progress' }],
    })
    throwsWithCode(() => engine.retryMilestone(state, 'm1'), 'ILLEGAL_TRANSITION')
    state.milestones[0]!.status = 'failed'
    engine.retryMilestone(state, 'm1')
    assert.equal(state.milestones[0]!.status, 'in_progress')
    throwsWithCode(() => engine.retryMilestone(state, 'ghost'), 'MILESTONE_UNKNOWN')
  })

  it('非 learning 阶段不能启动里程碑', () => {
    const { engine } = makeEngine()
    const state = makeState({ phase: 'analyzing' })
    throwsWithCode(() => engine.startNextMilestone(state), 'ILLEGAL_TRANSITION')
  })
})

describe('追问评分', () => {
  it('走完 unasked → asked → 提示阶梯 → 评分', () => {
    const { engine } = makeEngine()
    const question = makeQuestion('why etcd?')
    const state = makeState({ milestones: [makeMilestone('m1', [], [question])] })
    engine.askQuestion(state, 'm1', 0)
    assert.equal(question.status, 'asked')
    assert.equal(engine.giveHint(state, 'm1', 0), 'hint one')
    assert.equal(question.hintLevel, 1)
    assert.equal(engine.giveHint(state, 'm1', 0), 'hint two')
    assert.equal(engine.giveHint(state, 'm1', 0), null)
    engine.assessAnswer(state, 'm1', 0, true, 'explained the lease back')
    assert.equal(question.status, 'passed')
    assert.equal(question.note, 'explained the lease back')
  })

  it('已 asked 的问题重复提问是幂等的', () => {
    const { engine } = makeEngine()
    const state = makeState({ milestones: [makeMilestone('m1', [], [makeQuestion('q1')])] })
    engine.askQuestion(state, 'm1', 0)
    engine.askQuestion(state, 'm1', 0)
    assert.equal(state.milestones[0]!.questions[0]!.status, 'asked')
  })

  it('评分前必须先提问；失分后可以重提', () => {
    const { engine } = makeEngine()
    const state = makeState({ milestones: [makeMilestone('m1', [], [makeQuestion('q1')])] })
    throwsWithCode(() => engine.assessAnswer(state, 'm1', 0, true), 'ILLEGAL_TRANSITION')
    throwsWithCode(() => engine.giveHint(state, 'm1', 0), 'ILLEGAL_TRANSITION')
    engine.askQuestion(state, 'm1', 0)
    engine.assessAnswer(state, 'm1', 0, false, 'surface answer')
    assert.equal(state.milestones[0]!.questions[0]!.status, 'failed')
    engine.askQuestion(state, 'm1', 0)
    assert.equal(state.milestones[0]!.questions[0]!.status, 'asked')
  })

  it('已 passed 的问题不可再提问，未知问题下标被拒绝', () => {
    const { engine } = makeEngine()
    const state = makeState({ milestones: [makeMilestone('m1', [], [makeQuestion('q1', 'passed')])] })
    throwsWithCode(() => engine.askQuestion(state, 'm1', 0), 'ILLEGAL_TRANSITION')
    throwsWithCode(() => engine.askQuestion(state, 'm1', 7), 'QUESTION_UNKNOWN')
  })
})

describe('验证门记录', () => {
  it('退出码 0 且问题全部通过 → verified，并启动下一个里程碑', () => {
    const { engine } = makeEngine()
    const state = makeState({
      phase: 'learning',
      todos: [makeTodo('t1', 'done'), makeTodo('t2')],
      milestones: [makeMilestone('m1', ['t1'], [makeQuestion('q1', 'passed')]), makeMilestone('m2', ['t2'])],
    })
    state.milestones[0]!.status = 'in_progress'
    const outcome = engine.recordGate(state, 'm1', gateInput(0, 'ok'))
    assert.deepEqual(outcome, { kind: 'verified' })
    assert.equal(state.milestones[0]!.status, 'verified')
    assert.equal(state.milestones[1]!.status, 'in_progress')
    assert.equal(state.phase, 'learning')
    assert.equal(state.records.length, 1)
  })

  it('最后一个里程碑 verified 时整个流程 complete', () => {
    const { engine } = makeEngine()
    const state = makeState({
      phase: 'learning',
      todos: [makeTodo('t1', 'done')],
      milestones: [makeMilestone('m1', ['t1'])],
    })
    state.milestones[0]!.status = 'in_progress'
    engine.recordGate(state, 'm1', gateInput(0, 'ok'))
    assert.equal(state.phase, 'complete')
  })

  it('有问题未通过时保持 in_progress；非零退出则 failed', () => {
    const { engine } = makeEngine()
    const pending = makeState({
      phase: 'learning',
      todos: [makeTodo('t1', 'done')],
      milestones: [makeMilestone('m1', ['t1'], [makeQuestion('q1')])],
    })
    pending.milestones[0]!.status = 'in_progress'
    assert.deepEqual(engine.recordGate(pending, 'm1', gateInput(0, 'ok')), { kind: 'pending-questions' })
    assert.equal(pending.milestones[0]!.status, 'in_progress')

    assert.deepEqual(engine.recordGate(pending, 'm1', gateInput(1, 'compile error')), { kind: 'failed' })
    assert.equal(pending.milestones[0]!.status, 'failed')
    engine.retryMilestone(pending, 'm1')
    assert.equal(pending.milestones[0]!.status, 'in_progress')
  })

  it('拒绝给非 in_progress 里程碑记录验证门', () => {
    const { engine } = makeEngine()
    const state = makeState({ todos: [makeTodo('t1')], milestones: [makeMilestone('m1', ['t1'])] })
    throwsWithCode(() => engine.recordGate(state, 'm1', gateInput(0, 'ok')), 'ILLEGAL_TRANSITION')
    throwsWithCode(() => engine.recordGate(state, 'ghost', gateInput(0, 'ok')), 'MILESTONE_UNKNOWN')
  })

  it('按 maxCapturedOutput 截断捕获输出（保留尾部）', () => {
    const { engine } = makeEngine({ maxCapturedOutput: 20 })
    const state = makeState({
      phase: 'learning',
      todos: [makeTodo('t1')],
      milestones: [makeMilestone('m1', ['t1'])],
    })
    state.milestones[0]!.status = 'in_progress'
    engine.recordGate(state, 'm1', gateInput(0, 'x'.repeat(5000)))
    const record = state.records[0]!
    assert.equal(record.stdout.length, 20)
    assert.equal(record.stdout.startsWith('\u2026'), true)
  })
})

describe('持久化', () => {
  it('通过 ctx.fs 创建、读取、保存状态', async () => {
    const { engine, ctx } = makeEngine()
    await engine.create('/work', { origin: ORIGIN, scope: SCOPE })
    assert.equal(await engine.hasState('/work'), true)
    assert.equal(ctx.fs.files.has('/work/.paper/state.json'), true)

    const loaded = await engine.load('/work')
    assert.equal(loaded?.phase, 'analyzing')
    assert.equal(loaded?.origin.language, 'go')
    assert.deepEqual(loaded?.gates.go?.build, ['go', 'build', './...'])

    loaded!.phase = 'skeletonizing'
    const before = Date.now()
    await engine.save('/work', loaded!)
    const again = await engine.load('/work')
    assert.equal(again?.phase, 'skeletonizing')
    assert.equal(again!.updatedAt >= before, true)
  })

  it('拒绝第二次 create 以及 createIfAbsent 竞态', async () => {
    const { engine, ctx } = makeEngine()
    await engine.create('/work', { origin: ORIGIN, scope: SCOPE })
    await rejectsWithCode(engine.create('/work', { origin: ORIGIN, scope: SCOPE }), 'STATE_EXISTS')

    ctx.fs.files.set('/other/.paper/state.json', '{"stale":true}')
    ctx.fs.hideFromStat.add('/other/.paper/state.json')
    await rejectsWithCode(engine.create('/other', { origin: ORIGIN, scope: SCOPE }), 'STATE_EXISTS')
  })

  it('create 时拒绝没有验证门的语言', async () => {
    const { engine } = makeEngine()
    await rejectsWithCode(engine.create('/work', { origin: { path: '/p', language: 'rust' }, scope: SCOPE }), 'GATE_UNKNOWN')
  })

  it('状态缺失返回 undefined，内容损坏则拒绝', async () => {
    const { engine, ctx } = makeEngine()
    assert.equal(await engine.load('/missing'), undefined)

    ctx.fs.files.set('/bad/.paper/state.json', 'not json at all')
    await rejectsWithCode(engine.load('/bad'), 'STATE_INVALID')

    ctx.fs.files.set(
      '/bad2/.paper/state.json',
      JSON.stringify({
        schemaVersion: 1,
        phase: 'analyzing',
        origin: { path: '/p', language: 'go' },
        scope: { level: 'beginner' },
        gates: { go: { build: [] } },
        milestones: [{ id: 'm1', title: 'x', todos: ['ghost'], questions: [], status: 'pending' }],
        todos: [],
        records: [],
        updatedAt: 0,
      }),
    )
    await rejectsWithCode(engine.load('/bad2'), 'STATE_INVALID')
  })

  it('拒绝 schemaVersion 不符与非法阶段', async () => {
    const { engine, ctx } = makeEngine()
    ctx.fs.files.set('/v2/.paper/state.json', JSON.stringify({ schemaVersion: 2 }))
    await rejectsWithCode(engine.load('/v2'), 'STATE_INVALID')
    ctx.fs.files.set(
      '/badphase/.paper/state.json',
      JSON.stringify({ schemaVersion: 1, phase: 'nope', origin: { path: '/p', language: 'go' }, scope: { level: 'beginner' }, gates: { go: { build: [] } }, milestones: [], todos: [], records: [], updatedAt: 0 }),
    )
    await rejectsWithCode(engine.load('/badphase'), 'STATE_INVALID')
  })
})

describe('视图', () => {
  it('快照与描述能反映当前位置', () => {
    const { engine } = makeEngine()
    const state = makeState({
      phase: 'learning',
      todos: [makeTodo('t1', 'done'), makeTodo('t2')],
      milestones: [makeMilestone('m1', ['t1']), makeMilestone('m2', ['t2'], [makeQuestion('q1', 'passed')])],
    })
    state.milestones[0]!.status = 'verified'
    state.milestones[1]!.status = 'in_progress'
    const view = engine.snapshot(state)
    assert.equal(view.current?.id, 'm2')
    assert.equal(view.doneQuestionCount, 1)
    assert.equal(view.questionCount, 1)
    assert.equal(view.gateCount, 0)
    const text = engine.describe(state)
    assert.match(text, /代码演练状态/)
    assert.match(text, /phase: learning/)
    assert.match(text, /milestones: 1\/2 verified/)
    assert.match(text, /current: milestone m2/)
  })
})
