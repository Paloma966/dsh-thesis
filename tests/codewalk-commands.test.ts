/**
 * `/thesis-defense` 命令**代码演练侧**的处理器测试：`new` / `status` / `check`
 * 三个子命令，以及验证门在命令面上的失败、重试与「问题未过」分支。
 *
 * 命令的注册在装配层（`src/index.ts` + `src/commands.ts`），因此这里直接调用
 * `handleCodewalkCommand` —— 与真实调用路径共享同一份实现。
 *
 * @module dsh-thesis/tests/codewalk-commands
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { CodeWalkthroughOptions } from '../src/config.ts'
import { handleCodewalkCommand } from '../src/codewalk/commands.ts'
import type { AiLearningEngine } from '../src/codewalk/engine.ts'
import type { CommandResultShape } from '../src/codewalk/host-types.ts'
import { registerCodewalk } from '../src/codewalk/register.ts'
import { asContext, FakeContext, invocation } from './codewalk-fixtures.ts'

const CWD = '/work'

const OPTIONS: CodeWalkthroughOptions = {
  stateDir: '.paper',
  gates: { go: { build: ['go', 'build', './...'] } },
  maxCapturedOutput: 8000,
}

interface Harness {
  readonly ctx: FakeContext
  readonly engine: AiLearningEngine
  invoke(rawInput: string): Promise<CommandResultShape>
}

function makeHarness(): Harness {
  const ctx = new FakeContext()
  registerCodewalk(asContext(ctx), OPTIONS)
  const engine = ctx.get('paperCodeWalkthrough') as AiLearningEngine
  const invoke = (rawInput: string): Promise<CommandResultShape> => {
    return handleCodewalkCommand(asContext(ctx), engine, invocation(CWD, rawInput))
  }
  return { ctx, engine, invoke }
}

/** 通过 `/thesis-defense new` 在 CWD 下种下一个状态。 */
async function seedNew(harness: Harness, rawInput = 'new /src/project'): Promise<void> {
  const result = await harness.invoke(rawInput)
  assert.equal(result.kind, 'success')
}

/** 种下一个「已完成 todo + 已进入 learning」的里程碑。 */
async function seedMilestone(harness: Harness, questions = 0): Promise<void> {
  const state = (await harness.engine.load(CWD))!
  harness.engine.upsertTodo(state, {
    id: 't1',
    where: 'internal/store/task.go SaveTask',
    what: 'persists a task',
    steps: ['marshal', 'write'],
    difficulty: 2,
    status: 'done',
  })
  harness.engine.upsertMilestone(state, {
    id: 'm1',
    title: 'Task CRUD',
    todos: ['t1'],
    questions:
      questions === 0
        ? []
        : [{ ask: `q${questions}`, expected: ['point'], hints: ['hint'], status: 'unasked', hintLevel: 0 }],
    status: 'pending',
  })
  harness.engine.advancePhase(state, 'skeletonizing')
  harness.engine.advancePhase(state, 'learning')
  await harness.engine.save(CWD, state)
}

describe('子命令分派', () => {
  it('未知子命令给出可读错误并列出可用动作', async () => {
    const harness = makeHarness()
    const result = await harness.invoke('bogus')
    assert.equal(result.kind, 'error')
    assert.match((result as { text: string }).text, /未知子命令 "bogus"/)
    assert.match((result as { text: string }).text, /new \| status \| check/)
  })

  it('没有 fs 接缝时引擎调用会失败，但处理器把它变成可读错误', async () => {
    const ctx = new FakeContext({ fs: false })
    registerCodewalk(asContext(ctx), OPTIONS)
    const engine = ctx.get('paperCodeWalkthrough') as AiLearningEngine
    const result = await handleCodewalkCommand(asContext(ctx), engine, invocation(CWD, 'status'))
    assert.equal(result.kind, 'error')
  })
})

describe('/thesis-defense new', () => {
  it('用默认值创建状态并报告下一步', async () => {
    const harness = makeHarness()
    const result = await harness.invoke('new /src/project')
    assert.equal(result.kind, 'success')
    assert.match((result as { text: string }).text, /已为 \/src\/project 创建代码演练（go，beginner）/)
    const state = await harness.engine.load(CWD)
    assert.deepEqual(state?.origin, { path: '/src/project', language: 'go' })
    assert.equal(state?.phase, 'analyzing')
  })

  it('支持 --lang/--level/--module 两种写法，并拒绝非法 level', async () => {
    const harness = makeHarness()
    await seedNew(harness, 'new /src/p --lang go --level advanced --module pkg')
    const state = await harness.engine.load(CWD)
    assert.deepEqual(state?.scope, { level: 'advanced', module: 'pkg' })

    const harness2 = makeHarness()
    await seedNew(harness2, 'new /src/p --lang=go --level=intermediate --module=core')
    const state2 = await harness2.engine.load(CWD)
    assert.deepEqual(state2?.scope, { level: 'intermediate', module: 'core' })

    const bad = await harness2.invoke('status')
    assert.equal(bad.kind, 'success')
    const harness3 = makeHarness()
    const badLevel = await harness3.invoke('new /src/p --level guru')
    assert.equal(badLevel.kind, 'error')
    assert.match((badLevel as { text: string }).text, /非法的 level/)
  })

  it('拒绝缺少路径与重复创建', async () => {
    const harness = makeHarness()
    const missing = await harness.invoke('new')
    assert.equal(missing.kind, 'error')
    assert.match((missing as { text: string }).text, /用法：/)
    await seedNew(harness)
    const again = await harness.invoke('new /other')
    assert.equal(again.kind, 'error')
    assert.match((again as { text: string }).text, /已存在/)
  })

  it('未知子命令给出中文提示', async () => {
    const harness = makeHarness()
    const result = await harness.invoke('bogus')
    assert.equal(result.kind, 'error')
    assert.match((result as { text: string }).text, /未知子命令/)
  })
})

describe('/thesis-defense status', () => {
  it('无状态时报错，有状态时输出描述', async () => {
    const harness = makeHarness()
    const missing = await harness.invoke('status')
    assert.equal(missing.kind, 'error')
    assert.match((missing as { text: string }).text, /没有代码演练状态/)

    await seedNew(harness)
    const result = await harness.invoke('status')
    assert.equal(result.kind, 'success')
    assert.match((result as { text: string }).text, /代码演练状态/)
    assert.match((result as { text: string }).text, /phase: analyzing/)
  })
})

describe('/thesis-defense check', () => {
  it('无状态或没有可跑的里程碑时报错', async () => {
    const harness = makeHarness()
    assert.equal((await harness.invoke('check')).kind, 'error')
    await seedNew(harness)
    const result = await harness.invoke('check')
    assert.equal(result.kind, 'error')
    assert.match((result as { text: string }).text, /没有可检查的对象/)
  })

  it('未知里程碑 id 报错', async () => {
    const harness = makeHarness()
    await seedNew(harness)
    await seedMilestone(harness)
    const result = await harness.invoke('check nope')
    assert.equal(result.kind, 'error')
    assert.match((result as { text: string }).text, /未知里程碑/)
  })

  it('退出码 0 时验证里程碑并落盘记录', async () => {
    const harness = makeHarness()
    await seedNew(harness)
    await seedMilestone(harness)
    const result = await harness.invoke('check')
    assert.equal(result.kind, 'success')
    assert.match((result as { text: string }).text, /已验证/)
    assert.equal(harness.ctx.shell.calls[0]?.command, 'go build ./...')
    assert.equal(harness.ctx.shell.calls[0]?.workdir, CWD)

    const state = await harness.engine.load(CWD)
    assert.equal(state?.milestones[0]!.status, 'verified')
    assert.equal(state?.phase, 'complete')
    assert.equal(state?.records.length, 1)
  })

  it('非零退出时标记 failed 并回显 stderr', async () => {
    const harness = makeHarness()
    await seedNew(harness)
    await seedMilestone(harness)
    harness.ctx.shell.exitCode = 1
    harness.ctx.shell.stderrText = 'undefined: fmt'
    const result = await harness.invoke('check')
    assert.equal(result.kind, 'error')
    assert.match((result as { text: string }).text, /undefined: fmt/)
    const state = await harness.engine.load(CWD)
    assert.equal(state?.milestones[0]!.status, 'failed')
  })

  it('非零退出且 stderr 为空时回显 stdout 末尾', async () => {
    const harness = makeHarness()
    await seedNew(harness)
    await seedMilestone(harness)
    harness.ctx.shell.exitCode = 1
    harness.ctx.shell.stderrText = '   '
    harness.ctx.shell.stdoutText = 'build failed'
    const result = await harness.invoke('check')
    assert.match((result as { text: string }).text, /stdout 末尾/)
  })

  it('下一次 check 会重试 failed 里程碑', async () => {
    const harness = makeHarness()
    await seedNew(harness)
    await seedMilestone(harness)
    harness.ctx.shell.exitCode = 1
    await harness.invoke('check')
    harness.ctx.shell.exitCode = 0
    const result = await harness.invoke('check')
    assert.equal(result.kind, 'success')
    const state = await harness.engine.load(CWD)
    assert.equal(state?.milestones[0]!.status, 'verified')
  })

  it('验证门为绿但仍有未通过问题时报告剩余问题', async () => {
    const harness = makeHarness()
    await seedNew(harness)
    await seedMilestone(harness, 1)
    const result = await harness.invoke('check')
    assert.equal(result.kind, 'success')
    assert.match((result as { text: string }).text, /仍有 1 个问题未通过/)
    const state = await harness.engine.load(CWD)
    assert.equal(state?.milestones[0]!.status, 'in_progress')
  })

  it('验证门被中断时标记 failed 并报错', async () => {
    const harness = makeHarness()
    await seedNew(harness)
    await seedMilestone(harness)
    harness.ctx.shell.timedOut = true
    const result = await harness.invoke('check')
    assert.equal(result.kind, 'error')
    assert.match((result as { text: string }).text, /被中断/)
    const state = await harness.engine.load(CWD)
    assert.equal(state?.milestones[0]!.status, 'failed')
  })

  it('没有 shell 执行器时以中文内部错误返回', async () => {
    const harness = makeHarness()
    await seedNew(harness)
    await seedMilestone(harness)
    harness.ctx.services.delete('shell')
    const result = await harness.invoke('check')
    assert.equal(result.kind, 'error')
    assert.match((result as { text: string }).text, /没有组合 shell 执行器/)
  })
})
