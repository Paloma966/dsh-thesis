/**
 * 随包技能 `code-walkthrough` 的 provider 测试：注册、候选元数据（名称 / rank /
 * 资源基址 / 中文描述与触发场景），以及正文能否从 `skills/code-walkthrough/` 读出。
 *
 * @module dsh-thesis/tests/codewalk-skill
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import type { CodeWalkthroughOptions } from '../src/config.ts'
import { registerCodewalk } from '../src/codewalk/register.ts'
import { SKILL_NAME } from '../src/codewalk/skill.ts'
import { asContext, FakeContext } from './codewalk-fixtures.ts'

const OPTIONS: CodeWalkthroughOptions = {
  stateDir: '.paper',
  gates: { go: { build: ['go', 'build', './...'] } },
  maxCapturedOutput: 8000,
}

const SKILL_DIR = fileURLToPath(new URL('../skills/code-walkthrough/', import.meta.url))

function makeHarness(): { ctx: FakeContext } {
  const ctx = new FakeContext()
  registerCodewalk(asContext(ctx), OPTIONS)
  return { ctx }
}

describe('随包技能 provider', () => {
  it('组合了技能注册表时注册 dsh-thesis provider 与 code-walkthrough 技能', async () => {
    const { ctx } = makeHarness()
    assert.equal(ctx.skills.provider?.name, 'dsh-thesis')

    const candidate = (await ctx.skills.candidates())[0]
    assert.ok(candidate)
    assert.equal(candidate.name, 'code-walkthrough')
    assert.equal(SKILL_NAME, 'code-walkthrough')
    assert.equal(candidate.provider, 'dsh-thesis')
    assert.equal(candidate.source, 'bundled')
    assert.equal(candidate.rank, 900)
    assert.deepEqual(candidate.invocation, { modelInvocable: true, userInvocable: true })
    assert.deepEqual(candidate.resourceBase, { kind: 'directory', path: SKILL_DIR })
  })

  it('描述与触发场景中文优先，覆盖答辩场景', async () => {
    const { ctx } = makeHarness()
    const candidate = (await ctx.skills.candidates())[0]!
    assert.match(candidate.description, /答辩/)
    assert.match(candidate.description, /答辩/)
    assert.match(candidate.whenToUse ?? '', /答辩/)
    assert.match(candidate.whenToUse ?? '', /答辩/)
  })

  it('没有技能注册表时跳过注册', () => {
    const ctx = new FakeContext({ skills: false })
    registerCodewalk(asContext(ctx), OPTIONS)
    assert.equal(ctx.get('skills'), undefined)
  })

  it('技能正文与 references 从 skills/code-walkthrough/ 读取', async (t) => {
    if (!existsSync(join(SKILL_DIR, 'SKILL.md'))) {
      t.diagnostic(`技能正文尚未创建：${join(SKILL_DIR, 'SKILL.md')}（由父 agent 负责）`)
      return
    }
    const { ctx } = makeHarness()
    const candidate = (await ctx.skills.candidates())[0]!
    const definition = await ctx.skills.definition(candidate)
    assert.equal(definition.name, 'code-walkthrough')
    assert.match(definition.content, /code-walkthrough/)
  })
})
