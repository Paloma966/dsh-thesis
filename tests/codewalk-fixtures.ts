/**
 * `src/codewalk/**` 测试夹具：内存文件系统 + 结构化的假 Cordis 上下文。
 *
 * 为什么需要假 ctx：本仓库的依赖里**没有** `@deepseek-ai/cordis` 的运行时包
 * （见 `src/types/shims.d.ts` 的说明），所以测试不去 `new Context()` + `ctx.plugin()`，
 * 而是直接调 `registerCodewalk(ctx, options)`，用一个只实现引擎与各表面真正读取的
 * 字段的假上下文对象，再断言注册结果。
 *
 * 设计取舍：假上下文里一切「没被用到的能力」都保持最小（例如 `logger` 是空实现），
 * 而 `tools.register` / `commands.register` / `skills.registerProvider` 会把定义
 * 存下来供断言；只有 `agent/pre-step` 做了真的 waterfall 派发，因为 prestep 的行为
 * 必须端到端验证。
 *
 * @module dsh-thesis/tests/codewalk-fixtures
 */

import type { Context } from '@deepseek-ai/cordis'
import type { StateFileSystem, LearningFsTarget, LearningWriteIntent } from '../src/codewalk/fs-types.ts'
import type {
  CommandDefinitionShape,
  CommandInvocationShape,
  PreStepDecisionShape,
  SkillCandidateShape,
  SkillDefinitionShape,
  SkillsProviderShape,
  ToolDefinitionShape,
} from '../src/codewalk/host-types.ts'

/** 内存版 `StateFileSystem`，只实现引擎真正使用的四个原语。 */
export class FakeFileSystem implements StateFileSystem {
  readonly files = new Map<string, string>()
  /** stat 假装不存在的路径（模拟 createIfAbsent 的竞态）。 */
  readonly hideFromStat = new Set<string>()

  private key(path: string): string {
    return path.replace(/\/+$/, '') || '/'
  }

  async resolve(path: string, opts?: { cwd?: string }): Promise<LearningFsTarget> {
    const cwd = opts?.cwd ?? '/'
    const joined = path.startsWith('/') ? path : `${cwd}/${path}`
    return { targetKey: joined, displayPath: joined }
  }

  async stat(target: LearningFsTarget): Promise<{ version: number; type: string } | undefined> {
    const key = this.key(target.targetKey as string)
    if (this.hideFromStat.has(key) || !this.files.has(key)) return undefined
    return { version: 1, type: 'file' }
  }

  async readText(target: LearningFsTarget): Promise<string> {
    const content = this.files.get(this.key(target.targetKey as string))
    if (content === undefined) {
      const error = new Error('FS_NOT_FOUND') as Error & { code: string }
      error.code = 'FS_NOT_FOUND'
      throw error
    }
    return content
  }

  async writeText(target: LearningFsTarget, content: string, expected?: LearningWriteIntent): Promise<void> {
    const key = this.key(target.targetKey as string)
    if (expected !== undefined && 'createIfAbsent' in expected && this.files.has(key)) {
      const error = new Error('FS_NOT_OBSERVED') as Error & { code: string }
      error.code = 'FS_NOT_OBSERVED'
      throw error
    }
    this.files.set(key, content)
  }
}

/** 假工具注册表：记录注册过的工具定义。 */
export class FakeTools {
  readonly registered: ToolDefinitionShape[] = []

  register(definition: ToolDefinitionShape): unknown {
    this.registered.push(definition)
    return undefined
  }

  names(): string[] {
    return this.registered.map((definition) => definition.name)
  }

  /** 按名字取回已注册的工具；不存在时直接抛错（测试失败要响）。 */
  tool(name: string): ToolDefinitionShape {
    const found = this.registered.find((definition) => definition.name === name)
    if (found === undefined) throw new Error(`工具 ${name} 未注册`)
    return found
  }
}

/** 假命令注册表：记录最后注册的一条命令定义。 */
export class FakeCommands {
  readonly defs: CommandDefinitionShape[] = []

  register(definition: CommandDefinitionShape): unknown {
    this.defs.push(definition)
    return undefined
  }

  get def(): CommandDefinitionShape | undefined {
    return this.defs[0]
  }
}

/** 假技能注册表：记录 provider 与候选列表。 */
export class FakeSkills {
  provider: SkillsProviderShape | undefined

  registerProvider(create: (control: unknown) => SkillsProviderShape): () => void {
    this.provider = create({})
    return () => {}
  }

  async candidates(): Promise<readonly SkillCandidateShape[]> {
    if (this.provider === undefined) throw new Error('技能 provider 未注册')
    return await this.provider.list({})
  }

  async definition(candidate: SkillCandidateShape): Promise<SkillDefinitionShape> {
    if (this.provider === undefined) throw new Error('技能 provider 未注册')
    const definition = await this.provider.get(candidate, {})
    if (definition === undefined) throw new Error(`provider 没有返回技能 ${candidate.name}`)
    return definition
  }
}

/** 假 shell 执行器：退出码与输出可编程。 */
export class FakeShell {
  exitCode = 0
  stdoutText = 'ok'
  stderrText = ''
  timedOut = false
  aborted = false
  readonly calls: Array<{ command: string; workdir?: string; timeoutMs?: number; stdoutMaxBytes?: number }> = []

  async run(spec: { command: string; workdir?: string; timeoutMs?: number; stdoutMaxBytes?: number }) {
    this.calls.push(spec)
    return {
      exitCode: this.exitCode,
      signal: null,
      timedOut: this.timedOut,
      aborted: this.aborted,
      timeoutMs: spec.timeoutMs ?? 0,
      stdout: { text: this.stdoutText, truncated: false },
      stderr: { text: this.stderrText, truncated: false },
    }
  }
}

type PreStepListener = (
  payload: unknown,
  next: () => Promise<PreStepDecisionShape>,
) => Promise<PreStepDecisionShape>

/**
 * 结构化假上下文：`registerCodewalk` 需要的能力都在这里。
 *
 * 只有 `agent/pre-step` 做了真正的 waterfall 派发（按注册顺序串成链），
 * 其它事件仅记录。
 */
export class FakeContext {
  readonly services = new Map<string, unknown>()
  readonly fs: FakeFileSystem
  readonly tools = new FakeTools()
  readonly commands = new FakeCommands()
  readonly skills = new FakeSkills()
  readonly shell = new FakeShell()
  /** 是否已注册 `fs`；headless 组合可以没有。 */
  readonly providesFs: boolean
  readonly logger = {
    debug: (..._args: unknown[]): void => {},
    info: (..._args: unknown[]): void => {},
    warn: (..._args: unknown[]): void => {},
    error: (..._args: unknown[]): void => {},
  }
  private readonly listeners: Array<{ name: string; listener: PreStepListener; prepend?: boolean }> = []

  constructor(options: { fs?: boolean; tools?: boolean; commands?: boolean; skills?: boolean; shell?: boolean } = {}) {
    this.fs = new FakeFileSystem()
    this.providesFs = options.fs ?? true
    if (this.providesFs) this.services.set('fs', this.fs)
    if (options.tools ?? true) this.services.set('tools', this.tools)
    if (options.commands ?? true) this.services.set('commands', this.commands)
    if (options.skills ?? true) this.services.set('skills', this.skills)
    if (options.shell ?? true) this.services.set('shell', this.shell)
  }

  provide(name: string, value: unknown): void {
    this.services.set(name, value)
  }

  get(name: string): unknown {
    return this.services.get(name)
  }

  effect(callback: () => (() => void) | void, _label?: string): void {
    callback()
  }

  on(name: string, listener: (...args: never[]) => unknown, options?: { prepend?: boolean }): unknown {
    this.listeners.push({
      name,
      listener: listener as unknown as PreStepListener,
      ...(options?.prepend !== undefined ? { prepend: options.prepend } : {}),
    })
    return () => {
      const index = this.listeners.findIndex((entry) => entry.listener === listener)
      if (index >= 0) this.listeners.splice(index, 1)
    }
  }

  emit(_name: string, ..._args: unknown[]): void {}

  /** 派发一次 `agent/pre-step` waterfall，`fallback` 是链末端的基础决策。 */
  async dispatchPreStep(
    payload: unknown,
    fallback: () => Promise<PreStepDecisionShape>,
  ): Promise<PreStepDecisionShape> {
    const chain = this.listeners.filter((entry) => entry.name === 'agent/pre-step')
    let index = -1
    const runNext = async (): Promise<PreStepDecisionShape> => {
      index += 1
      const entry = chain[index]
      if (entry === undefined) return await fallback()
      return await entry.listener(payload, runNext)
    }
    return await runNext()
  }
}

/** 把假上下文交给需要真实 `Context` 类型的函数（仅编译期转换）。 */
export function asContext(fake: FakeContext): Context {
  return fake as unknown as Context
}

/** 一次命令调用的最小 invocation。 */
export function invocation(cwd: string, rawInput: string): CommandInvocationShape {
  return {
    commandId: 'cmd-1',
    agent: { session: { header: { cwd } } },
    rawInput,
    signal: new AbortController().signal,
  }
}

/** 断言一段同步代码抛出的错误带有指定 `code`。 */
export function throwsWithCode(fn: () => void, code: string): Error {
  try {
    fn()
  } catch (error) {
    const actual = (error as { code?: unknown }).code
    if (actual !== code) {
      throw new Error(`期望错误码 ${code}，实际是 ${String(actual)}（${String((error as Error).message)}）`)
    }
    return error as Error
  }
  throw new Error(`期望抛出带 code=${code} 的错误，但没有抛出`)
}

/** 断言一个 promise 以指定 `code` 拒绝。 */
export async function rejectsWithCode(promise: Promise<unknown>, code: string): Promise<Error> {
  try {
    await promise
  } catch (error) {
    const actual = (error as { code?: unknown }).code
    if (actual !== code) {
      throw new Error(`期望错误码 ${code}，实际是 ${String(actual)}（${String((error as Error).message)}）`)
    }
    return error as Error
  }
  throw new Error(`期望以 code=${code} 拒绝，但 resolve 了`)
}
