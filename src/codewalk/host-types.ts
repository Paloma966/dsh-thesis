/**
 * 本插件可选消费的宿主表面的结构化契约：命令注册表、shell 执行器，以及接收
 * 命令的 agent。
 *
 * 刻意**不**从 `@deepseek-ai/dsh-*` 导入：已发布的 rc.1 依赖树引用了未发布的包，
 * 因此外部 bundle 不能安装 dsh 包。这些接口只声明插件真正读取的字段；宿主真实的
 * 服务在运行期满足它们。必需的 `fs` 接缝在 `fs-types.ts` 里。
 *
 * @module dsh-thesis/codewalk
 */

/** shell 执行器捕获的一条输出流。 */
export interface CollectedOutputShape {
  /** 捕获到的文本 —— 发生截断时是这条流的**尾部**。 */
  readonly text: string
  /** 为 true 表示 `text` 中丢弃了字节。 */
  readonly truncated: boolean
  /** 保存**完整**流的文件路径（若可用）。 */
  readonly spillPath?: string
}

/** 前台 shell 结果：非零退出会正常 resolve，绝不 reject。 */
export interface ShellRunResultShape {
  /** 退出码；进程被信号杀死时为 null。 */
  readonly exitCode: number | null
  /** 终止信号（如 'SIGTERM'）；正常退出时为 null。 */
  readonly signal: string | null
  /** 为 true 表示执行器自身的超时杀掉了命令。 */
  readonly timedOut: boolean
  /** 为 true 表示调用方的 AbortSignal 杀掉了命令。 */
  readonly aborted: boolean
  /** 本次运行实际生效的超时。 */
  readonly timeoutMs: number
  readonly stdout: CollectedOutputShape
  readonly stderr: CollectedOutputShape
}

/** 插件会设置的 shell 执行请求子集。 */
export interface ShellExecSpecShape {
  /** 完整命令行，如 "go build ./..."。 */
  readonly command: string
  readonly workdir?: string
  readonly timeoutMs?: number
  readonly stdoutMaxBytes?: number
  readonly signal?: AbortSignal
  /** 由调用会话解析出的本次调用沙箱策略。 */
  readonly sandboxPolicy?: unknown
}

/** shell 接缝（`ctx.shell`）；每个宿主由一个 bash provider 提供。 */
export interface ShellServiceShape {
  run(spec: ShellExecSpecShape): Promise<ShellRunResultShape>
}

/** 命令被调用时所针对的接收 agent 切片。 */
export interface AgentShape {
  readonly session: {
    readonly header: {
      /** 会话工作目录；DSH 契约里可缺省（例如无工作区的会话）。 */
      readonly cwd?: string
    }
  }
}

/** 传给某个已注册命令 handler 的调用信息。 */
export interface CommandInvocationShape {
  readonly commandId: unknown
  readonly agent: AgentShape
  readonly rawInput: string
  readonly signal: AbortSignal
}

/** 由调度 UI 直接渲染的命令结果。 */
export type CommandResultShape =
  | { readonly kind: 'success'; readonly text?: string }
  | { readonly kind: 'error'; readonly text: string }

/** 插件自有命令注册（`ctx.commands.register`）。 */
export interface CommandDefinitionShape {
  readonly name: string
  readonly description: string
  readonly input?: { readonly hint: string }
  readonly recordInput?: boolean
  handler(invocation: CommandInvocationShape): CommandResultShape | Promise<CommandResultShape>
}

/** 命令注册表（`ctx.commands`）；在 headless 组合里是可选的。 */
export interface CommandsServiceShape {
  register(definition: CommandDefinitionShape): unknown
}

/** 面向模型的消息或工具渲染中的一个文本内容块。 */
export interface TextBlockShape {
  readonly type: 'text'
  readonly text: string
}

/** 工具注册表（`ctx.tools`）；在无执行器的组合里是可选的。 */
export interface ToolsServiceShape {
  register(definition: ToolDefinitionShape): unknown
}

/** 一个已注册的工具：JSON Schema 参数 + 执行 + 渲染。 */
export interface ToolDefinitionShape {
  readonly name: string
  readonly description: string
  /** 参数的 JSON Schema 对象。 */
  readonly parameters: Record<string, unknown>
  readonly output: {
    readonly schema: Record<string, unknown>
    render(args: unknown, value: unknown): TextBlockShape[]
  }
  execute(args: unknown, exec: ToolRunContextShape): Promise<unknown>
  readonly timeoutMs?: number
}

/** 交给工具主体的运行期上下文。 */
export interface ToolRunContextShape {
  readonly callId: unknown
  /** 本次调用所代表的 agent；在无执行器的循环里缺席。 */
  readonly agent?: AgentShape
  readonly signal: AbortSignal
}

/** 为 pre-step 上下文注入的一条临时 user 角色消息。 */
export interface InjectedUserMessageShape {
  readonly id: string
  readonly role: 'user'
  readonly content: readonly TextBlockShape[]
  readonly source: {
    readonly kind: 'plugin'
    readonly plugin: string
    readonly form: string
    readonly sections: readonly { readonly name: string; readonly text: string }[]
  }
}

/** 插件扩展的 `agent/pre-step` waterfall 决策。 */
export interface PreStepDecisionShape {
  readonly kind: 'enter' | 'reject'
  readonly messages: readonly InjectedUserMessageShape[]
}

/** 一次 `agent/pre-step` waterfall 派发的载荷。 */
export interface PreStepPayloadShape {
  readonly agent: AgentShape
  readonly turn: number
  readonly step: number
  readonly signal: AbortSignal
}

/** 技能摘要携带的模型/用户可调用性开关。 */
export interface SkillInvocationPolicyShape {
  readonly modelInvocable: boolean
  readonly userInvocable: boolean
}

/** provider 特有的相对技能资源基址。 */
export type SkillResourceBaseShape =
  | { readonly kind: 'directory'; readonly path: string }
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'opaque'; readonly description: string }

/** 一条 provider 目录条目。 */
export interface SkillCandidateShape {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly invocation: SkillInvocationPolicyShape
  readonly provider: string
  readonly source: string
  readonly resourceBase?: SkillResourceBaseShape
  /** 同名技能里 rank 更小者胜出。 */
  readonly rank: number
  /** provider 自有的不透明句柄，会原样传回 `provider.get()`。 */
  readonly locator: unknown
  readonly path?: string
  readonly metadata?: Readonly<Record<string, unknown>>
}

/** `provider.get()` 返回的完整已解析技能正文。 */
export interface SkillDefinitionShape {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly invocation: SkillInvocationPolicyShape
  readonly provider: string
  readonly source: string
  readonly resourceBase?: SkillResourceBaseShape
  readonly content: string
  readonly path?: string
  readonly metadata?: Readonly<Record<string, unknown>>
}

/** 注册在 `ctx.skills` 上的一个技能来源。 */
export interface SkillsProviderShape {
  readonly name: string
  list(options: unknown): Promise<readonly SkillCandidateShape[]>
  get(candidate: SkillCandidateShape, options: unknown): Promise<SkillDefinitionShape | undefined>
}

/** 技能注册表（`ctx.skills`）；在最小组合里是可选的。 */
export interface SkillsServiceShape {
  registerProvider(create: (control: unknown) => SkillsProviderShape): () => void
}
