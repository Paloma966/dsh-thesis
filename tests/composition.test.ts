/**
 * 装配测试：用**假宿主**跑通 `apply()`，断言整个插件对外暴露的表面。
 *
 * 这是本仓库最重要的一条集成测试：它不验证任何业务逻辑，只验证「各模块被同一个
 * `apply()` 正确挂上、名字没有漂移、闸门装上了、服务注册了」。
 * 因为没有真实宿主运行时，`definePaperTool` 在这里走离线实现（见
 * `src/shared/define-tool.ts`），真实宿主的兼容性由 `scripts/host-smoke.mjs` 复核。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import { apply, Config, PAPER_DEFAULTS, resolveConfig } from '../src/index.ts'
import { FakeFs } from './paper-fixtures.ts'

/** 本插件对外承诺的模型工具全集（名字是契约，改名就是破坏性变更）。 */
const EXPECTED_TOOLS = [
  // 论文工作区：材料 → 要求 → 阶段 → 论文
  'thesis_ingest', 'thesis_intake', 'thesis_init', 'thesis_progress', 'thesis_decide',
  'thesis_lit_search', 'thesis_lit_save', 'thesis_lit_note',
  'thesis_review', 'thesis_check', 'thesis_build', 'thesis_stylecheck',
  // 原创性自查
  'thesis_originality',
  // 答辩：素材 / 幻灯 / 代码演练
  'thesis_defense', 'thesis_slides',
  'defense_code_status', 'defense_code_next', 'defense_code_update',
  // 跨会话事实（学生不必直接调用，但模型需要）
  'fact_search', 'fact_remember', 'fact_context',
].sort()

/** 斜杠命令全集（命令名只允许 [a-z][a-z0-9_-]*）。 */
const EXPECTED_COMMANDS = [
  'thesis-status', 'thesis-decide', 'thesis-lit', 'thesis-check', 'thesis-build',
  'thesis-ingest', 'thesis-intake', 'thesis-originality', 'thesis-defense',
].sort()

/** 命名空间规则：论文工作区 `thesis_*` / 跨会话事实 `fact_*` / 代码演练 `defense_code_*`。 */
const NAMESPACE_PREFIXES: readonly string[] = ['thesis_', 'fact_', 'defense_code_']

interface FakeHost {
  readonly ctx: Context
  readonly tools: string[]
  readonly commands: string[]
  readonly definitions: Array<{
    name: string
    description: string
    parameters: Record<string, { type?: string; oneOf?: unknown; required?: unknown }>
    output?: { schema?: unknown; render?: unknown }
  }>
  readonly provided: Map<string, unknown>
  readonly effects: string[]
  readonly listeners: Map<string, number>
}

/** 最小的假宿主：只实现插件真正用到的 Context 表面。 */
function fakeHost(): FakeHost {
  const tools: string[] = []
  const commands: string[] = []
  const definitions: FakeHost['definitions'] = []
  const provided = new Map<string, unknown>()
  const effects: string[] = []
  const listeners = new Map<string, number>()

  const toolRegistry = {
    register(definition: FakeHost['definitions'][number]): () => void {
      if (definition === null || typeof definition !== 'object' || typeof definition.name !== 'string') {
        throw new Error('tools.register 收到非法定义')
      }
      tools.push(definition.name)
      definitions.push(definition)
      return () => {}
    },
  }
  const commandRegistry = {
    register(definition: { name?: string }): () => void {
      if (typeof definition?.name !== 'string') throw new Error('commands.register 收到非法定义')
      commands.push(definition.name)
      return () => {}
    },
  }

  const ctx = {
    tools: toolRegistry,
    commands: commandRegistry,
    provide(name: string, value: unknown): void {
      provided.set(name, value)
    },
    // 真实宿主里 ctx.get('tools') / ctx.get('commands') 也能取到注册表；
    // 有些模块（代码演练、幻灯）用这种更防御的方式取用，假宿主必须同样支持。
    get(name: string): unknown {
      if (provided.has(name)) return provided.get(name)
      if (name === 'tools') return toolRegistry
      if (name === 'commands') return commandRegistry
      return undefined
    },
    effect(callback: () => (() => void) | void, label?: string): void {
      effects.push(label ?? '(anonymous)')
      callback()
    },
    on(event: string): unknown {
      listeners.set(event, (listeners.get(event) ?? 0) + 1)
      return () => {}
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    fs: new FakeFs(),
  } as unknown as Context

  return { ctx, tools, commands, definitions, provided, effects, listeners }
}

test('apply() 挂载全部 21 个工具、9 个命令、2 个服务与 4 类闸门监听', () => {
  const host = fakeHost()
  apply(host.ctx, { memoryPath: ':memory:' })

  const missing = EXPECTED_TOOLS.filter(name => !host.tools.includes(name))
  const extra = host.tools.filter(name => !EXPECTED_TOOLS.includes(name))
  assert.deepEqual(missing, [], `缺少工具：${missing.join(', ')}`)
  assert.deepEqual(extra, [], `多出工具：${extra.join(', ')}`)
  assert.deepEqual([...host.tools].sort(), EXPECTED_TOOLS, '工具名集合必须与契约一致')

  // 命名空间规则：每个工具都必须落在三个前缀之一，不允许游离命名。
  for (const name of host.tools) {
    assert.ok(
      NAMESPACE_PREFIXES.some(prefix => name.startsWith(prefix)),
      `工具 ${name} 不在 thesis_ / fact_ / defense_code_ 任一命名空间内`,
    )
  }

  const missingCommands = EXPECTED_COMMANDS.filter(name => !host.commands.includes(name))
  assert.deepEqual(missingCommands, [], `缺少命令：${missingCommands.join(', ')}`)
  assert.deepEqual([...host.commands].sort(), EXPECTED_COMMANDS, '命令名集合必须与契约一致')
  assert.ok(host.provided.has('memory'), 'ctx.memory 必须被注册')
  assert.ok(host.provided.has('paperCodeWalkthrough'), 'ctx.paperCodeWalkthrough 必须被注册')
  assert.deepEqual(
    [...host.listeners.entries()].sort(),
    [['agent/pre-step', 4], ['tools/pre-execute', 1]],
    'agent/pre-step 应由写作意图闸门、事实回灌、代码演练进度卡、意图规格闸门各装一个；tools/pre-execute 由不可逆操作闸门装一个',
  )
  assert.ok(host.effects.includes('dsh-thesis.memory.closeDatabase'), '事实库必须注册卸载清理')
})

test('重复装配不会互相污染（两次 apply 各自独立收集）', () => {
  const first = fakeHost()
  const second = fakeHost()
  apply(first.ctx, { memoryPath: ':memory:' })
  apply(second.ctx, { memoryPath: ':memory:' })
  assert.deepEqual([...first.tools].sort(), [...second.tools].sort())
  assert.equal(first.tools.length, EXPECTED_TOOLS.length)
})

test('每个工具都有可路由的描述与合法的注册形态 schema', () => {
  const host = fakeHost()
  apply(host.ctx, { memoryPath: ':memory:' })
  assert.equal(host.definitions.length, EXPECTED_TOOLS.length, '应收集到全部工具定义')
  for (const definition of host.definitions) {
    assert.ok(
      typeof definition.description === 'string' && definition.description.length >= 20,
      `${definition.name} 的描述太短，模型无法据此路由`,
    )
    assert.equal(typeof definition.output?.render, 'function', `${definition.name} 缺少 output.render`)
    assert.ok(definition.output?.schema !== undefined, `${definition.name} 缺少 output.schema`)

    // 注册形态：参数根必须编译成 `{type:'object', properties, required?}`，
    // 且每个属性的 schema 有 type（或 oneOf）；这是宿主 registry 会校验的形态。
    const parameters = definition.parameters as {
      type?: string
      properties?: Record<string, { type?: string; oneOf?: unknown }>
      required?: unknown
    }
    assert.equal(parameters.type, 'object', `${definition.name} 的参数根必须是 object`)
    if (parameters.required !== undefined) {
      assert.ok(Array.isArray(parameters.required), `${definition.name} 的 required 必须是数组（JSON Schema 形态）`)
    }
    for (const [param, spec] of Object.entries(parameters.properties ?? {})) {
      assert.ok(
        typeof spec?.type === 'string' || Array.isArray(spec?.oneOf),
        `${definition.name}.${param} 缺少 type/oneOf`,
      )
      assert.notEqual((spec as { required?: unknown })?.required, true, `${definition.name}.${param} 的逐属性 required 未被提升`)
    }
  }
})

test('配置解析：嵌套块补默认值，未给的字段不产生 undefined 漂移', () => {
  const resolved = resolveConfig({ similarity: { threshold: 0.5 } })
  assert.equal(resolved.similarity.threshold, 0.5, '用户显式值优先')
  assert.equal(resolved.similarity.shingle, PAPER_DEFAULTS.similarity.shingle, '其余字段补默认值')
  assert.equal(resolved.ppt.engine, 'auto')
  assert.equal(resolved.intake.specRel, '00-管理/意图规格.md')
  assert.ok(resolved.codeWalkthrough.gates.go !== undefined)
  assert.deepEqual(resolveConfig({}).codeWalkthrough.gates, PAPER_DEFAULTS.codeWalkthrough.gates)
  assert.equal(resolved.workspace, undefined, '未配置 workspace 时必须是 undefined（走向上探测）')
  assert.ok(resolved.gates.destructiveRules.length > 0, '闸门默认值必须补全，不能静默关闸门')
})

test('配置 schema 可被 schemastery 校验并填入默认值', () => {
  const validated = Config({
    memoryPath: ':memory:',
    similarity: { shingle: 6 },
  } as never) as unknown as {
    memoryPath: string
    writingGate: boolean
    destructiveGate: boolean
    maxQuestions: number
    stylecheck: { reportRel: string }
    codeWalkthrough: { stateDir: string }
    similarity: { shingle: number; threshold: number }
  }
  assert.equal(validated.memoryPath, ':memory:')
  assert.equal(validated.writingGate, true)
  assert.equal(validated.destructiveGate, true)
  assert.equal(validated.maxQuestions, 3)
  assert.equal(validated.similarity.shingle, 6)
  assert.equal(validated.similarity.threshold, PAPER_DEFAULTS.similarity.threshold)
  assert.equal(validated.stylecheck.reportRel, PAPER_DEFAULTS.stylecheck.reportRel)
  assert.equal(validated.codeWalkthrough.stateDir, PAPER_DEFAULTS.codeWalkthrough.stateDir)
})
