/**
 * 装配测试：原来这一层需要先 `npm run build` 再 import `lib/index.js`，现在改为
 * 直接对 `registerCodewalk` 做单元验证 —— 用一个只实现引擎与各表面真正读取字段的假
 * ctx（见 `codewalk-fixtures.ts`），断言各表面都被注册、并且缺哪个表面都不会炸。
 *
 * 注意：`/thesis-defense` 命令的注册在装配层（`src/index.ts` + `src/commands.ts`），
 * 不在本模块，因此这里不断言命令面。
 *
 * @module dsh-thesis/tests/codewalk-composition
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { CodeWalkthroughOptions } from '../src/config.ts'
import type { AiLearningEngine } from '../src/codewalk/engine.ts'
import { registerCodewalk } from '../src/codewalk/register.ts'
import { asContext, FakeContext } from './codewalk-fixtures.ts'

const OPTIONS: CodeWalkthroughOptions = {
  stateDir: '.paper',
  gates: { go: { build: ['go', 'build', './...'] } },
  maxCapturedOutput: 8000,
}

describe('registerCodewalk 装配', () => {
  it('把引擎注册为 paperCodeWalkthrough 服务，并注册工具与技能两个表面', async () => {
    const ctx = new FakeContext()
    registerCodewalk(asContext(ctx), OPTIONS)

    const engine = ctx.get('paperCodeWalkthrough') as AiLearningEngine
    assert.notEqual(engine, undefined)
    assert.equal(engine.config.stateDir, '.paper')
    assert.equal(engine.config.maxCapturedOutput, 8000)
    assert.deepEqual(Object.keys(engine.config.gates), ['go'])

    assert.deepEqual(ctx.tools.names(), ['defense_code_status', 'defense_code_next', 'defense_code_update'])
    assert.equal(ctx.skills.provider?.name, 'dsh-thesis')
    assert.equal(ctx.services.has('paperCodeWalkthrough'), true)
  })

  it('缺任何一个可选表面都只跳过该表面（不抛错）', async () => {
    const bare = new FakeContext({ tools: false, commands: false, skills: false, shell: false })
    registerCodewalk(asContext(bare), OPTIONS)
    assert.equal(bare.tools.registered.length, 0)
    assert.equal(bare.commands.defs.length, 0)
    assert.equal(bare.skills.provider, undefined)
    assert.notEqual(bare.get('paperCodeWalkthrough'), undefined)
  })

  it('使用传入的 stateDir，不硬编码 .paper', async () => {
    const ctx = new FakeContext({ tools: false, commands: false, skills: false })
    registerCodewalk(asContext(ctx), { ...OPTIONS, stateDir: '.walkthrough-state' })
    const engine = ctx.get('paperCodeWalkthrough') as AiLearningEngine
    await engine.create('/w', { origin: { path: '/p', language: 'go' }, scope: { level: 'beginner' } })
    assert.equal(ctx.fs.files.has('/w/.walkthrough-state/state.json'), true)
  })

  it('引擎默认值在缺配置时回退（stateDir=.paper / 语言门 go）', async () => {
    const ctx = new FakeContext({ tools: false, commands: false, skills: false })
    registerCodewalk(asContext(ctx), { stateDir: '.paper' } as CodeWalkthroughOptions)
    const engine = ctx.get('paperCodeWalkthrough') as AiLearningEngine
    await engine.create('/w', { origin: { path: '/p', language: 'go' }, scope: { level: 'beginner' } })
    const state = await engine.load('/w')
    assert.deepEqual(state?.gates.go?.build, ['go', 'build', './...'])
    await assert.rejects(
      engine.create('/w2', { origin: { path: '/p', language: 'rust' }, scope: { level: 'beginner' } }),
      /没有配置验证门/,
    )
  })

  it('没有 fs 接缝时引擎调用会失败（宿主必须提供 fs）', async () => {
    const ctx = new FakeContext({ fs: false, tools: false, commands: false, skills: false })
    registerCodewalk(asContext(ctx), OPTIONS)
    const engine = ctx.get('paperCodeWalkthrough') as AiLearningEngine
    await assert.rejects(engine.load('/w'))
  })
})
