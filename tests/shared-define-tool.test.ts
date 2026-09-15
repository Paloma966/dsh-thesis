/**
 * 工具定义器（`definePaperTool`）的单元测试。
 *
 * 这里测的是**离线实现**：它必须把作者侧 DSL 编译成宿主认可的 JSON Schema 子集，
 * 并在参数违规时抛出与宿主同码（`INVALID_ARGS`）的错误。生产环境走宿主自己的
 * `defineTool`，两者的等价性由 `scripts/host-smoke.mjs` 在真实宿主上复核。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  compileParameterSchema,
  compileValueSchema,
  definePaperTool,
  PaperToolArgsError,
  usingHostDefineTool,
} from '../src/shared/define-tool.ts'

test('参数编译：逐属性 required:true 提升为根级 required 数组', () => {
  const schema = compileParameterSchema({
    root: { type: 'string', required: true, description: '工作区路径' },
    git: { type: 'boolean' },
    limit: { type: 'integer', default: 10 },
  })
  assert.equal(schema.type, 'object')
  assert.deepEqual(schema.required, ['root'])
  const properties = schema.properties as Record<string, Record<string, unknown>>
  assert.equal(properties.root!.type, 'string')
  assert.equal(properties.root!.description, '工作区路径')
  assert.equal(properties.root!.required, undefined, 'required 不应残留在属性上')
  assert.equal(properties.limit!.default, 10)
  assert.equal(schema.additionalProperties, undefined, '参数根与宿主一致：不写 additionalProperties')
})

test('参数编译：数组项与枚举', () => {
  const schema = compileParameterSchema({
    ids: { type: 'array', required: true, items: { type: 'string' } },
    action: { type: 'string', required: true, enum: ['a', 'b'] },
  })
  assert.deepEqual(schema.required, ['ids', 'action'])
  const properties = schema.properties as Record<string, any>
  assert.deepEqual(properties.ids.items, { type: 'string' })
  assert.deepEqual(properties.action.enum, ['a', 'b'])
})

test('值编译：object 展开 properties/required/additionalProperties，数组与 oneOf 递归', () => {
  const schema = compileValueSchema({
    type: 'object',
    additionalProperties: false,
    properties: {
      results: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            key: { type: 'string', required: true },
            confidence: { type: 'number', required: true },
          },
        },
      },
    },
  })
  assert.deepEqual(schema.required, ['results'])
  assert.equal(schema.additionalProperties, false)
  const results = (schema.properties as any).results
  assert.equal(results.items.type, 'object')
  assert.deepEqual(results.items.required, ['key', 'confidence'])
  assert.equal(results.items.additionalProperties, false)

  const union = compileValueSchema({ oneOf: [{ type: 'string' }, { type: 'null' }] })
  assert.deepEqual(union.oneOf, [{ type: 'string' }, { type: 'null' }])
})

test('值编译：json 节点退化为纯注解，不施加类型约束', () => {
  const schema = compileValueSchema({ type: 'json', description: '任意值' })
  assert.equal(schema.type, undefined)
  assert.equal(schema.description, '任意值')
})

test('作者错误在装配期大声失败', () => {
  assert.throws(() => compileValueSchema({ type: 'object' }), /additionalProperties|缺少/)
  assert.throws(() => compileValueSchema({ oneOf: [{ type: 'string' }] }), /至少需要两个分支/)
  assert.throws(() => compileValueSchema({} as never), /缺少 type/)
})

test('离线实现：合法参数放行，缺失必填/类型不符抛 INVALID_ARGS', async () => {
  const tool = definePaperTool({
    name: 'demo_tool',
    description: 'demo',
    parameters: {
      root: { type: 'string', required: true },
      limit: { type: 'integer' },
      tags: { type: 'array', items: { type: 'string' } },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(args) {
      return `ok:${args.root}`
    },
  }) as { execute(args: unknown, exec: unknown): Promise<unknown> }

  assert.equal(await tool.execute({ root: '/tmp/x' }, {}), 'ok:/tmp/x')

  await assert.rejects(tool.execute({}, {}), (error: unknown) => {
    assert.ok(error instanceof PaperToolArgsError)
    assert.equal((error as PaperToolArgsError).code, 'INVALID_ARGS')
    assert.match((error as Error).message, /invalid arguments: root 为必填参数/)
    return true
  })

  await assert.rejects(tool.execute({ root: '/tmp/x', limit: 1.5 }, {}), /期望 integer/)
  await assert.rejects(tool.execute({ root: '/tmp/x', tags: ['a', 2] }, {}), /tags\[1\] 期望 string/)
})

test('生产/离线模式自述一致', () => {
  // 离线跑测试时必须是 false；在真实宿主里跑同一个断言会失败，用于提醒不要误判。
  assert.equal(usingHostDefineTool, false)
})
