/**
 * 工具定义器：**生产用宿主的 `defineTool`，离线用本地等价实现**。
 *
 * 为什么需要它：本插件的工具定义用的是 DSH 的作者侧 schema DSL（`required: true`
 * 是**每个属性**的注解，不是 JSON Schema 的 `required` 数组），必须编译成宿主
 * 认可的 JSON Schema 子集后才能交给 `ctx.tools.register`。这个编译步骤由
 * `@deepseek-ai/dsh-tools` 的 `defineTool` 完成——但它是**运行时**依赖：
 * 在没有宿主的离线环境（`npm test`、评审、CI）里 import 它会直接 ERR_MODULE_NOT_FOUND，
 * 于是所有注册工具的模块都无法被单测加载，装配测试也写不出来。
 *
 * 解法是双模：
 * - **生产**：动态 import 宿主的 `defineTool`，行为与 DSH 第一方插件完全一致
 *   （含宿主自己的参数校验与 `ToolArgsError`）；
 * - **离线**：退回本文件里的等价实现，覆盖本插件实际使用的 DSL 子集
 *   （string/number/integer/boolean/array/object/json/oneOf/enum/const + 注解），
 *   并提供同样的"参数违规 → `INVALID_ARGS`"行为。
 *
 * 编译结果的一致性由两件事兜底：① `tests/shared-define-tool.test.ts` 逐例断言
 * 编译产物；② `scripts/host-smoke.mjs` 在真实 DSH 宿主上注册并执行工具（见 README「开发」）。
 *
 * @module dsh-thesis/shared/define-tool
 */

import type { ToolExecution } from '@deepseek-ai/dsh-tools'

/** 作者侧值 schema（本插件用到的子集）。 */
interface ValueSpec {
  type?: string
  description?: string
  title?: string
  default?: unknown
  examples?: unknown
  enum?: readonly unknown[]
  const?: unknown
  items?: ValueSpec
  properties?: Record<string, ValueSpec & { required?: true }>
  additionalProperties?: boolean
  oneOf?: readonly ValueSpec[]
  required?: true
}

/** 工具定义（作者侧形态）。 */
export interface PaperToolOptions {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, ValueSpec & { required?: true }>
  readonly output: {
    readonly schema: ValueSpec
    render(args: any, value: any): Array<{ type: 'text'; text: string }>
  }
  execute(args: any, exec: ToolExecution): Promise<unknown>
}

/** 编译期错误：作者写错了 schema（与宿主一样，装配时大声失败）。 */
function authorError(message: string): never {
  throw new Error(`dsh-thesis defineTool: ${message}`)
}

function copyAnnotations(from: ValueSpec, to: Record<string, unknown>): void {
  for (const key of ['description', 'title', 'default', 'examples'] as const) {
    if (from[key] !== undefined) to[key] = from[key]
  }
}

/** 把「属性映射 + 逐属性 required」编译成 `{properties, required}` 形式。 */
function compilePropertyMap(spec: Record<string, ValueSpec & { required?: true }>, path: string): {
  properties: Record<string, unknown> | undefined
  required: string[] | undefined
} {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [name, raw] of Object.entries(spec ?? {})) {
    if (raw === null || typeof raw !== 'object') authorError(`${path}.${name} 必须是对象`)
    const { required: isRequired, ...rest } = raw
    if (isRequired === true) required.push(name)
    properties[name] = compileValue(rest as ValueSpec, `${path}.${name}`)
  }
  return {
    properties: Object.keys(properties).length > 0 ? properties : undefined,
    required: required.length > 0 ? required : undefined,
  }
}

/** 编译一个值 schema 节点。 */
function compileValue(spec: ValueSpec, path: string): Record<string, unknown> {
  if (spec === null || typeof spec !== 'object') authorError(`${path} 必须是对象`)
  const out: Record<string, unknown> = {}
  copyAnnotations(spec, out)

  if (spec.oneOf !== undefined) {
    if (!Array.isArray(spec.oneOf) || spec.oneOf.length < 2) authorError(`${path}.oneOf 至少需要两个分支`)
    out.oneOf = spec.oneOf.map((branch, index) => compileValue(branch, `${path}.oneOf[${index}]`))
    return out
  }

  const type = spec.type
  if (type === undefined) authorError(`${path} 缺少 type`)
  // 作者专用：只作注解，不施加约束（对应宿主把 json 节点编译为注解式 schema）。
  if (type === 'json') return out

  out.type = type
  if (spec.enum !== undefined) out.enum = spec.enum
  if (spec.const !== undefined) out.const = spec.const

  if (type === 'object') {
    // 与宿主作者侧契约一致：object 必须显式声明开放性（additionalProperties: boolean），
    // 避免"忘了写"被静默解释成任一种语义。
    if (typeof spec.additionalProperties !== 'boolean') {
      authorError(`${path}: type 'object' 必须显式声明 additionalProperties（true=开放 / false=封闭）`)
    }
    const compiled = compilePropertyMap(spec.properties ?? {}, path)
    if (compiled.properties !== undefined) out.properties = compiled.properties
    if (compiled.required !== undefined) out.required = compiled.required
    out.additionalProperties = spec.additionalProperties
  } else if (type === 'array') {
    if (spec.items !== undefined) out.items = compileValue(spec.items, `${path}.items`)
  }
  return out
}

/** 把作者侧的隐式开放参数对象编译成根级 JSON Schema。 */
export function compileParameterSchema(spec: Record<string, ValueSpec & { required?: true }>): Record<string, unknown> {
  const compiled = compilePropertyMap(spec, 'parameters')
  return {
    type: 'object',
    ...compiled.properties !== undefined ? { properties: compiled.properties } : {},
    ...compiled.required !== undefined ? { required: compiled.required } : {},
  }
}

/** 编译输出 schema。 */
export function compileValueSchema(spec: ValueSpec): Record<string, unknown> {
  return compileValue(spec, 'schema')
}

// ---------------------------------------------------------------------------
// 离线参数校验（等价于宿主 defineTool 内部对模型实参的校验）
// ---------------------------------------------------------------------------

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function jsonTypeOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  return typeof value
}

function typeMatches(schema: Record<string, unknown>, value: unknown): boolean {
  const expected = schema.type
  if (expected === undefined) return true
  const actual = jsonTypeOf(value)
  if (expected === 'number') return actual === 'number' || actual === 'integer'
  if (expected === 'integer') return actual === 'integer'
  if (expected === 'null') return actual === 'null'
  // 注解式 json 节点不约束类型。
  if (expected === 'json') return true
  return actual === expected
}

/** 递归校验一个值；返回路径限定的违规列表（空数组 = 通过）。 */
function validateValue(schema: Record<string, unknown>, value: unknown, path: string): string[] {
  const violations: string[] = []
  const oneOf = schema.oneOf as Record<string, unknown>[] | undefined
  if (oneOf !== undefined) {
    const ok = oneOf.some(branch => validateValue(branch, value, path).length === 0)
    if (!ok) violations.push(`${path || '(root)'} 不满足 oneOf 的任何一个分支`)
    return violations
  }
  if (!typeMatches(schema, value)) {
    violations.push(`${path || '(root)'} 期望 ${String(schema.type)}，实际 ${describe(value)}`)
    return violations
  }
  const enumValues = schema.enum as readonly unknown[] | undefined
  if (enumValues !== undefined && !enumValues.some(candidate => Object.is(candidate, value))) {
    violations.push(`${path || '(root)'} 取值不在枚举内（${enumValues.map(v => JSON.stringify(v)).join(' / ')}）`)
  }
  if (schema.type === 'object' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    const required = (schema.required as string[] | undefined) ?? []
    for (const name of required) {
      if (record[name] === undefined) violations.push(`${path ? `${path}.` : ''}${name} 为必填参数`)
    }
    const properties = (schema.properties as Record<string, Record<string, unknown>> | undefined) ?? {}
    for (const [name, childSchema] of Object.entries(properties)) {
      const child = record[name]
      if (child === undefined) continue
      violations.push(...validateValue(childSchema, child, path ? `${path}.${name}` : name))
    }
  }
  if (schema.type === 'array' && Array.isArray(value)) {
    const items = schema.items as Record<string, unknown> | undefined
    if (items !== undefined) {
      value.forEach((item, index) => {
        violations.push(...validateValue(items, item, `${path}[${index}]`))
      })
    }
  }
  return violations
}

/** 参数违规：与宿主同名的错误码，便于 UI/日志统一识别。 */
export class PaperToolArgsError extends Error {
  readonly code = 'INVALID_ARGS'
  readonly violations: string[]
  constructor(violations: string[]) {
    super(`invalid arguments: ${violations.join('; ')}`)
    this.name = 'PaperToolArgsError'
    this.violations = violations
  }
}

/** 离线实现：编译 + 校验 + 返回注册就绪的定义。 */
function localDefineTool(options: PaperToolOptions): unknown {
  const parameters = compileParameterSchema(options.parameters)
  const outputSchema = compileValueSchema(options.output.schema)
  const render = options.output.render
  return {
    name: options.name,
    description: options.description,
    parameters,
    output: { schema: outputSchema, render: (args: any, value: any) => render(args, value) },
    async execute(args: any, exec: ToolExecution) {
      const violations = validateValue(parameters, args, '')
      if (violations.length > 0) throw new PaperToolArgsError(violations)
      return options.execute(args, exec)
    },
  }
}

/**
 * 生产用宿主 `defineTool`，离线为 `undefined`。
 *
 * 顶层 await 的代价是一次模块加载；收益是「离线可测」与「生产同源」两者兼得。
 */
let hostDefineTool: ((options: unknown) => unknown) | undefined
try {
  const host = await import('@deepseek-ai/dsh-tools')
  if (typeof (host as { defineTool?: unknown }).defineTool === 'function') {
    hostDefineTool = (host as { defineTool: (options: unknown) => unknown }).defineTool
  }
} catch {
  hostDefineTool = undefined
}

/** 是否运行在真实宿主内（供工具返回值与测试断言使用）。 */
export const usingHostDefineTool = hostDefineTool !== undefined

/**
 * 定义一个模型工具。
 *
 * 优先宿主实现（与 DSH 第一方插件完全一致），离线退回本地等价实现。
 */
export function definePaperTool(options: PaperToolOptions): unknown {
  return hostDefineTool !== undefined ? hostDefineTool(options) : localDefineTool(options)
}
