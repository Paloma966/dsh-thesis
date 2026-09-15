# DSH 第三方插件宿主 API 参考（0.1.5-rc.1）

只记录契约：签名、类型、事件名、注册与加载规则。签名逐字摘自已安装产物的 `lib/types/**/*.d.ts` 与 `lib/*.js`，
冲突处已标注。安装根：`C:\Users\TTTT\AppData\Local\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\`

---

## 1. 插件模块契约（`@deepseek-ai/cordis`）

```ts
namespace Plugin {                                     // cordis/lib/types/registry.d.ts
  interface Base<T = any> {
    name?: string; Config?: StandardSchemaV1<any, T>; inject?: Inject
    provide?: string | string[]; intercept?: Dict<boolean>
  }
  interface Function<T = any> extends Base<T> { (ctx: Context, config: T): any }
  interface Constructor<T = any> extends Base<T> { new (ctx: Context, config: T): any }
  interface Object<T = any> extends Base<T> { apply(ctx: Context, config: T): any }
}
type Inject<M = Dict> = (keyof M)[] | { [K in keyof M]?: M[K] }
// name=诊断名；Config=启动前校验 config 的 Standard Schema（schemastery 满足）；inject=依赖服务名

export const name = 'my-plugin'
export const inject = ['fs']                                // 服务齐备前保持 PENDING，不加载
export const Config = z.object({ stateDir: z.string().default('.my-plugin') })
export type MyConfig = z.infer<typeof Config>
export function apply(ctx: Context, config: MyConfig = {}): void { /* ... */ }
```

函数插件用 `export const inject`，class 插件用 `static inject`，延迟到服务就绪再跑用 `ctx.inject(deps, cb)`。
**函数插件不要 `export default`**（只有 class service 用 default export）。

### 1.1 `ctx` 核心方法

```ts
interface Context {                                    // cordis/lib/types/context.d.ts
  root: this; baseUrl?: string
  events: EventsService; logger: LoggerService; reflect: ReflectService
  registry: RegistryService; fiber: Fiber
  get<K extends string & keyof this>(name: K, strict?: boolean): undefined | this[K]
  set<K extends string & keyof this>(name: K, value: undefined | this[K]): void
  provide<K extends string & keyof this>(name: K, value: undefined | this[K]): () => void  // 返回注销 disposer
  // 以上三者各另有 (name: string, ...) => any 的非类型化重载
  accessor(name: string, options: Omit<Property.Accessor, 'type'>): void
  mixin<K extends string & keyof this>(name: K, mixins: (keyof this & keyof this[K])[] | Dict<string>): void
  on<K extends keyof Events>(name: K, listener: Events[K], options?: boolean | EventOptions): () => boolean
  once<K extends keyof Events>(name: K, listener: Events[K], options?: boolean | EventOptions): () => boolean
  emit<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): void
  parallel<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): Promise<void>
  serial<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): Promisify<ReturnType<Events[K]>>
  bail<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): ReturnType<Events[K]>
  waterfall<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): ReturnType<Events[K]>
  plugin<P extends Plugin>(plugin: P, ...args: Spread<GetPluginConfig<P>>): Fiber & PromiseLike<Fiber>
  inject(deps: Inject, callback: Plugin.Function<void>): Fiber & PromiseLike<Fiber>
}
interface EventOptions { prepend?: boolean; global?: boolean }
interface Fiber {
  uid: number | null; readonly ctx: Context; config: any
  state: FiberState                    // PENDING=0 LOADING=1 ACTIVE=2 FAILED=3 DISPOSED=4 UNLOADING=5
  readonly dispose: () => Promise<void>; await(): Promise<this>; restart(): Promise<void>
  update(config: any, noSave?: boolean): void | Promise<void>
  effect(execute: () => SyncEffect, label?: string): Disposable<Promise<void>>
  effect(execute: () => Effect, label?: string): AsyncDisposable<Promise<void>>
  getEffects(): EffectMeta[]
}
```

**disposal**：`provide` / `on` / `effect` 的 disposer 都归属当前 fiber，fiber 卸载时按注册**逆序**自动执行。
`ctx.effect(fn, label)` 的 `fn` 可返回 disposer、disposer 数组、`Promise<disposer>` 或 async generator：
`ctx.effect(() => { const t = setInterval(tick, 1000); return () => clearInterval(t) }, 'my-plugin.interval')`。

### 1.2 `Config`（schemastery `z`）

```ts
z.string(): Schema<string>;  z.number(): Schema<number>;  z.natural(): Schema<number>;  z.percent(): Schema<number>
z.boolean(): Schema<boolean>; z.date(): Schema<string | Date, Date>; z.regExp(flag?): Schema<string | RegExp, RegExp>
z.array<X>(inner: X): Schema<TypeS<X>[], TypeT<X>[]>
z.dict<X, Y extends Schema<any, string> = Schema<string>>(inner: X, sKey?: Y): Schema<Dict<...>, Dict<...>>
z.object<X extends Dict>(dict: X): Schema<ObjectS<X>, ObjectT<X>>
z.union<const X>(list: readonly X[]): Schema<TypeS<X>, TypeT<X>>
z.intersect<const X>(list: readonly X[]): Schema<IntersectS<X>, IntersectT<X>>
z.transform<X, T>(inner: X, cb: (v: TypeS<X>, o: Options) => T, preserve?: boolean): Schema<TypeS<X>, T>
// 链式：.default(v) .description(text) .required(v?) .hidden(v?) .loose(v?) .disabled(v?)
//   .collapse(v?) .role(text, extra?) .link(s) .comment(s) .min(n) .max(n) .step(n) .set(k, schema)
```

Cordis 用 `resolveConfig(runtime, config)` 把 `Config` 当 Standard Schema 校验；失败 → fiber `FAILED`，`await fiber` 抛 `ValidationError`。
服务声明可 `declare module '@deepseek-ai/cordis' { interface Context { myService: MyService } }`，也可不声明类型而用
`ctx.provide('myService', obj)` + `ctx.get('myService')`（本插件用后者规避对 `@deepseek-ai/dsh-*` 的类型依赖）。

---

## 2. 工具：`@deepseek-ai/dsh-tools`

### 2.1 `defineTool` 精确签名

```ts
export declare function defineTool<const S extends ParameterSchemaSpec, const O extends ValueSchemaSpec>(
  options: DefineToolOptions<S, O>): ToolDefinition

export interface DefineToolOptions<S extends ParameterSchemaSpec, O extends ValueSchemaSpec> {
  readonly name: string
  readonly description: string
  readonly parameters: S                     // 隐式开放对象根 —— 是 DSL，不是 JSON Schema
  readonly output: {
    readonly schema: O
    render(args: InferArgs<S>, value: InferValue<NoInfer<O>>): ContentBlock[]
    presentationMeta?(args: InferArgs<S>, value: InferValue<NoInfer<O>>): JsonValue
  }
  readonly timeoutMs?: number
  isConcurrencySafe?(args: InferArgs<S>): boolean
  execute(args: InferArgs<S>, exec: ToolRunContext): Promise<InferValue<NoInfer<O>>>
  finalizeContent?(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined
  presentCall?(args: InferArgs<S>): ToolCallView | undefined
  presentResult?(args: InferArgs<S>, result: ToolResult): ToolResultView | undefined
}
```

### 2.2 参数/输出 schema DSL（全部字段描述符）

```ts
interface ValueSchemaAnnotations { description?: string; title?: string; default?: JsonValue; examples?: JsonValue }
interface StringValueSchemaSpec  extends ValueSchemaAnnotations { type: 'string';  enum?: readonly string[];  const?: string }
interface NumberValueSchemaSpec  extends ValueSchemaAnnotations { type: 'number';  enum?: readonly number[];  const?: number }
interface IntegerValueSchemaSpec extends ValueSchemaAnnotations { type: 'integer'; enum?: readonly number[];  const?: number }
interface BooleanValueSchemaSpec extends ValueSchemaAnnotations { type: 'boolean'; enum?: readonly boolean[]; const?: boolean }
interface NullValueSchemaSpec    extends ValueSchemaAnnotations { type: 'null';    enum?: readonly null[];    const?: null }
interface ArrayValueSchemaSpec   extends ValueSchemaAnnotations { type: 'array';   items?: ValueSchemaSpec }
interface ObjectValueSchemaSpec  extends ValueSchemaAnnotations {  // additionalProperties 必填：显式声明开放性
  type: 'object'; properties?: ParameterSchemaSpec; additionalProperties: boolean }
interface JsonValueSchemaSpec    extends ValueSchemaAnnotations { type: 'json' }   // 仅供作者，编译为注解式 schema
interface OneOfValueSchemaSpec   extends ValueSchemaAnnotations {  // 至少两个分支
  oneOf: readonly [ValueSchemaSpec, ValueSchemaSpec, ...ValueSchemaSpec[]] }
type ValueSchemaSpec = StringValueSchemaSpec | NumberValueSchemaSpec | IntegerValueSchemaSpec
  | BooleanValueSchemaSpec | NullValueSchemaSpec | ArrayValueSchemaSpec
  | ObjectValueSchemaSpec | JsonValueSchemaSpec | OneOfValueSchemaSpec
type ParameterPropertySpec = ValueSchemaSpec & { required?: true }                 // required 是每属性注解
type ParameterSchemaSpec = { [key: string]: ParameterPropertySpec; [key: symbol]: never }
type InferValue<S> = /* 精确推导，最多 16 层容器，之后退化为 JsonValue */
type InferArgs<S>  = InferProperties<S, []>
```

`defineTool` 用 `parameterSchemaSpecToJsonSchema` / `valueSchemaSpecToJsonSchema` 编译成受支持的 JSON Schema 子集；
每次 `execute` 前用 `validateArgs(spec, args)`（= `validateJsonSchemaValue`）校验，违规抛 `ToolArgsError`（`code: 'INVALID_ARGS'`）。

### 2.3 约定与 `exec` 上下文

```ts
interface ToolExecutionInput {
  readonly callId: ToolCallId; readonly rootCallId?: ToolCallId; readonly name: string
  readonly arguments: unknown; readonly agent?: Agent          // 无 agent 的组合为 undefined
  readonly parent?: ToolExecutionToken; readonly signal: AbortSignal
}
interface ToolExecution extends ToolExecutionInput { readonly rootCallId: ToolCallId; readonly token: ToolExecutionToken }
interface ToolRunContext extends ToolExecution {
  deferContext(context: UserMessage): void                     // 结果之后注入的上下文
  concludeTurn(): void                                         // 成功即结束当前轮
}
const cwd = exec.agent?.session.header.cwd                     // string | undefined ← 会话工作目录
```

- `execute` 只返回**规范 JSON 值**；不符 `output.schema` → `ToolOutputError`（`violations: string[]`）。
  > **不一致**：`.d.ts` 写 `constructor(toolName: string, violations: string[])`，`lib/index.js` 实为 `constructor(violations)`；以运行时为准。
- `render(args, value)` 的返回值就是模型看到的 `content`（`ContentBlock[]`，通常 `[{ type: 'text', text }]`）。
- `execute` 抛出 → `Error: <message>` 的 `isError` 结果；结构化身份走 `ToolFailure.info = { name, code }`。失败不结束轮次。
- 取消：调用前取消 → `ABORTED_BEFORE_DISPATCH`；调用后取消 → `ABORTED`。必须把 `exec.signal` 传给下游 I/O。
- `timeoutMs` 只是**声明**，注册表不强制；需要 `@deepseek-ai/dsh-tool-call-timeout-policy` 包装层。
- `Agent` 另有 `agent.ctx`（agent 作用域 Context）、`agent.inbox`、`agent.status`、`agent.options`、`agent.session`、
  `cancel(cause, opts?)`、`whenIdle()`、`runMaintenance(task)`、`inject/steer/followup/send`。

### 2.4 注册

```ts
ctx.tools.register(definition: ToolDefinition): () => void              // 返回注销 disposer
ctx.tools.guard(guard: (exec: Readonly<ToolExecution>) => string | undefined): () => void
ctx.tools.restrict(filter: { allow?: readonly string[]; deny?: readonly string[] }): () => void
ctx.tools.get(name: string, scope?: ScopeKey): ToolDefinition | undefined
ctx.tools.schemas(scope?: ScopeKey): ToolSchema[]
ctx.tools.execute(exec: ToolExecutionInput): Promise<ToolExecutionResult>
```

注册强制：同层重名抛错；`run_code` 为 PTC 保留名（注册/遮蔽均抛错）；`output` 必须是带 `render` 函数的对象；
`output.schema` 必须落在受支持子集内；`timeoutMs` 若是则必须为正有限数。
流程：`tools/pre-execute` → `ctx.tools.guard()` → `tools/execute` → `tools/post-execute` → `finalizeContent` → `tools/result`。
`restrict()` 要求 agent 作用域 Context（`agent.ctx`）；空过滤器与未知工具名（含保留名）抛错。

### 2.5 最小可运行工具

```ts
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'

export function registerTools(ctx: Context, readAll: (cwd: string, rel: string, signal: AbortSignal) => Promise<string>): void {
  ctx.tools.register(defineTool({
    name: 'my_read',
    description: 'Read one file inside the current session workspace.',
    parameters: { path: { type: 'string', required: true }, maxLines: { type: 'integer' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        path: { type: 'string', required: true }, text: { type: 'string', required: true } } },
      render: (_a, v) => [{ type: 'text', text: v.text }],
    },
    async execute(args, exec) {
      const cwd = exec.agent?.session.header.cwd ?? process.cwd()
      return { path: args.path, text: await readAll(cwd, args.path, exec.signal) }
    },
  }))
}
```

---

## 3. 文件系统：`@deepseek-ai/dsh-fs`

`ctx.fs` 是抽象 `FileSystem extends Service`；**全部**成员如下（不省略，无其他方法）：

```ts
abstract class FileSystem extends Service {
  get sandboxMode(): SandboxMode | undefined        // 基类/裸本机后端为 undefined（不限制）
  abstract resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget>
  abstract processPath(target: FsTarget): string
  processPathFromHostPath(hostPath: string): string | undefined
  abstract fileUrl(target: FsTarget): string
  abstract contains(parent: FsTarget, child: FsTarget): boolean
  abstract stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined>
  abstract lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined>
  abstract readText(target: FsTarget, signal?: AbortSignal): Promise<string>
  abstract streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>>
  abstract readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array>
  abstract readByteRange(target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal): Promise<Uint8Array>
  abstract listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]>
  abstract writeText(target: FsTarget, content: string, expected?: FsWriteIntent,
                     signal?: AbortSignal, sandboxPolicy?: SandboxExecutionPolicy): Promise<FsWriteOutcome>
  abstract editText(target: FsTarget, edit: FsEditRequest, expected?: { version: FsVersion },
                    signal?: AbortSignal, sandboxPolicy?: SandboxExecutionPolicy): Promise<FsEditOutcome>
}

interface FsTarget    { targetKey: FsTargetKey; displayPath: string }   // targetKey 不透明，禁止解析
interface FsInfo      { version: FsVersion; type: 'file' | 'directory' | 'other'; size?: number }
interface FsPathInfo  { version: FsVersion; type: 'file' | 'directory' | 'symlink' | 'other'; size?: number }
interface FsDirEntry  { name: string; type: 'file' | 'directory' | 'other'; target: FsTarget; version?: FsVersion; size?: number }
type FsObservation = { kind: 'present'; version: FsVersion } | { kind: 'absent' }
type FsWriteIntent = { kind: 'createIfAbsent' } | { kind: 'replaceIfVersion'; version: FsVersion }
interface FsEditRequest { oldString: string; newString: string; replaceAll: boolean }
interface FsWriteOutcome { operation: 'create' | 'update'; version: FsVersion; before: string | null; after: string }
interface FsEditOutcome  { version: FsVersion; before: string; after: string }
type FsErrorCode = 'FS_NOT_FOUND' | 'FS_NOT_DIRECTORY' | 'FS_NOT_TEXT' | 'FS_NOT_REGULAR_FILE' | 'FS_TOO_LARGE'
  | 'FS_PERMISSION_DENIED' | 'FS_SANDBOX_DENIED' | 'FS_IO_ERROR' | 'FS_STALE_VERSION' | 'FS_NOT_OBSERVED'
  | 'FS_AMBIGUOUS_EDIT' | 'FS_EDIT_NOT_FOUND' | 'FS_ABORTED'
class FsError extends HarnessError { readonly code: FsErrorCode; constructor(message: string, code: FsErrorCode, options?: ErrorOptions) }
```

### 3.1 关键契约（也是"缺失能力"的正式答案）

- **没有 `exists()`**：存在性 = `await fs.stat(target) !== undefined`（或 `lstat(path)`）。
- **没有递归列举**：`listDir` 只返回直接子项，按名字稳定排序、不含内容；递归/glob/分页/搜索要自己实现。
- **没有 delete / rename / copy / watch**：整个 seam 就是上面 13 个原语（README 明写"只有十三个原语"）。
- **变更只支持文本**：`writeText`/`editText` 遇二进制或非 UTF-8 → `FS_NOT_TEXT`；`readBytes`/`readByteRange` 是原始字节**读**原语，
  **二进制安全的写入不存在**。
- **路径解析**：相对路径以 `opts.cwd` 为基准（省略用后端默认基准）。`resolve` 跟随符号链接得到稳定身份 → 同一文件不同路径产生
  同一 `targetKey`；"不跟随最后一跳"用 `lstat(path, { cwd })`。`displayPath` 才是给模型/UI 的路径。
- **原子性**：写入与编辑都原子；编辑在可选 `expected.version` 下先校验新鲜度再字面匹配
  （`FS_STALE_VERSION` / `FS_AMBIGUOUS_EDIT` / `FS_EDIT_NOT_FOUND`）。
- **上限**：`readBytes` 超 `maxBytes` → `FS_TOO_LARGE`（不截断）；`readByteRange` 由调用方对 `length` 负责。
- **无 I/O deadline**；取消只有每原语上的可选 `AbortSignal`。

### 3.2 `fs/*` 策略事件（全部三个）

```ts
// 单槽决策 waterfall：第一个返回值即决策，绝不调用 next()。next() = 无条件写入。
'fs/write-intent'(target: FsTarget, actor: object | undefined,
  next: () => FsWriteIntent | undefined | Promise<FsWriteIntent | undefined>): Promise<FsWriteIntent | undefined>
// 单槽决策 waterfall：next() = 无条件编辑。
'fs/edit-intent'(target: FsTarget, actor: object | undefined,
  next: () => { version: FsVersion } | undefined | Promise<{ version: FsVersion } | undefined>): Promise<{ version: FsVersion } | undefined>
// emit：同步记录；抛错会让工具调用失败，返回的 Promise 不会被 await。
'fs/observed'(target: FsTarget, observation: FsObservation, actor: object | undefined): void
```

`actor` 是发起调用的执行对象（`dsh-tool-fs` 传 `exec`；策略按 `actor.name === 'edit' | 'write'` 判定）。

---

## 4. 人类斜杠命令：`@deepseek-ai/dsh-commands`

```ts
ctx.commands.register(definition: CommandDefinition): () => void

interface CommandDefinition {
  readonly name: string                 // 斜杠后的小写名，不含 '/'
  readonly description: string
  readonly input?: CommandInputDescriptor
  readonly recordInput?: boolean        // 默认 true；设 false 让命令自己的领域事件持有输入载荷
  readonly handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>
}
interface CommandInputDescriptor { readonly hint: string; readonly attachments?: boolean }
interface CommandInvocation {
  readonly commandId: CommandId; readonly agent: Agent          // 精确的接收 agent
  readonly rawInput: string                                     // 命令名之后的每个字节，含分隔空白
  readonly attachments: readonly (ImageBlock | FileBlock)[]; readonly signal: AbortSignal
}
type CommandResult =
  | { kind: 'success'; text?: string; sourceEventSeq?: SessionSeq }
  | { kind: 'error'; text: string }
```

**名称规则（运行时强制）**：`const COMMAND_NAME = /^[a-z][a-z0-9_-]*$/u`；不匹配 →
`TypeError: command name "X" must match /^[a-z][a-z0-9_-]*$/u`。同层重名注册抛错。
**命令行语法**：第 0 字节必须是 `/`，随后小写名，名后为行尾或**空白**；名后一切（含分隔空白）是 `rawInput`。
语法非法或名字未知的行由适配器拒绝，不会变成模型提示词。`agent.ctx` 下注册的定义只对该 agent 遮蔽全局同名定义。
**取当前会话 / cwd**：`CommandInvocation` 没有 session 字段 —— 经 agent 取：
`const cwd: string | undefined = invocation.agent.session.header.cwd`
**返回 UI 文本**：`{ kind: 'success', text }` 或 `{ kind: 'error', text }`，由分发 UI 直接渲染，**不进入模型历史**。

```ts
const commands = ctx.get('commands') as { register(d: CommandDefinition): unknown } | undefined
if (commands === undefined) return                       // headless/ACP 组合没有命令面，静默跳过

commands.register({
  name: 'my-status',
  description: 'Show my plugin state for this session',
  input: { hint: '[verbose]' },
  handler: ({ agent, rawInput }) => {
    const cwd = agent.session.header.cwd
    if (cwd === undefined) return { kind: 'error', text: 'no session workspace' }
    return { kind: 'success', text: `cwd: ${cwd}\ninput: ${rawInput.trim()}` }
  },
})
```

生命周期：`execute()` 先追加仅写日志的 `command/run`，结算时追加 `command/done`（抛错/取消以 `kind: 'error'` 结算）；
准入未通过的输入不记录任何事件。注册/注销触发 `commands/change`（emit，无参）。

---

## 5. Skill：`@deepseek-ai/dsh-skill` + `dsh-skill-filesystem`

### 5.1 编程式注册（精确方法名与参数）

```ts
ctx.skills.register(skill: SkillRegistration): () => void

type SkillRegistration = Omit<SkillDefinition, 'invocation' | 'provider'> & {
  readonly invocation?: SkillInvocationPolicy   // 省略 = 模型与用户都为 true
  readonly provider?: string                    // 省略 = 注册表自有的 'runtime'
}
interface SkillDefinition extends SkillSummary {
  readonly content: string                      // 必填：指令正文
  readonly path?: string; readonly metadata?: Readonly<Record<string, unknown>>
}
interface SkillSummary {
  readonly name: string                         // kebab-case
  readonly description: string; readonly whenToUse?: string
  readonly invocation: SkillInvocationPolicy; readonly source: SkillSource
  readonly provider: string; readonly resourceBase?: SkillResourceBase
}
interface SkillInvocationPolicy { readonly modelInvocable: boolean; readonly userInvocable: boolean }
type SkillSource = 'project-dsh' | 'project-agents' | 'runtime' | 'user-dsh' | 'user-agents' | 'custom' | 'bundled' | (string & {})

ctx.skills.registerProvider(create: (control: SkillProviderControl) => SkillProvider): () => void
interface SkillProviderControl { readonly signal: AbortSignal; readonly invalidate: () => void }
interface SkillProvider {
  readonly name: string
  readonly list: (o: SkillLookupOptions) => Promise<readonly SkillCandidate[] | SkillProviderObservation>
  readonly get: (c: SkillCandidate, o: SkillLookupOptions) => Promise<SkillDefinition | undefined>
}
```

`registerProvider` 同步注册；同层重名或使用保留名 `runtime` 抛错；disposer 或 fiber 卸载即注销并失效缓存。
同层同名 runtime 注册先到先得（后者得 no-op disposer + 警告）。
Skill 名文法：`const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/`（可用 `isSkillName(name)`）。

### 5.2 发现目录与优先级（rank 小者胜）

| rank | `source` | 路径 |
|---|---|---|
| 100 | `project-dsh` | `<projectRoot>/.dsh/skills` |
| 200 | `project-agents` | `<projectRoot>/.agents/skills` |
| 300 | `custom` | `Config.customSkillDirs` 各项 |
| 400 | `user-dsh` | `<dshHome>/skills`（跳过其 `.system` 子目录） |
| 500 | `user-agents` | `<agentsHome>/skills` |
| 600 | `bundled` | `Config.bundledSkillDir` / `$DSH_BUNDLED_SKILL_DIR`（`BUNDLED_SKILL_RANK`，`trustedHost`） |

`projectRoot` = 含 `.git` 的最近祖先目录，无则用查询 cwd；`dshHome` 默认 `$DSH_HOME` 或 `~/.dsh`，
`agentsHome` 默认 `$DSH_AGENTS_HOME` 或 `~/.agents`。发现深度固定为 1：`<root>/<name>/SKILL.md` 或 `<root>/<name>.md`，
**不支持嵌套 `**/SKILL.md`**。层间同名由就近层覆盖；**rank 只决定同层内去重**。
`includeDefaultRoots: false` 同时去掉项目根、用户根与 `$DSH_BUNDLED_SKILL_DIR` 默认值。

### 5.3 `SKILL.md` frontmatter 契约

```yaml
---
name: my-skill                # 必填，kebab-case
description: One-line routing description.   # 必填
whenToUse: Optional extra routing guidance.  # 可选
metadata: { owner: team-x }                  # 可选，任意对象 → candidate.metadata
disable-model-invocation: true               # 可选：true 则从模型面目录与 loader 排除
user-invocable: false                        # 可选：false 则从用户面命令排除
---
正文 Markdown。每次加载都重读文件，正文没有版本/缓存协议。
```

布尔键接受 YAML 布尔以及不分大小写的 `true/false`、`yes/no`、`on/off`、`1/0`；其他拼写或非布尔值 → 整个 skill 连警告一起丢弃。
旧键 `disableModelInvocation` / `modelInvocable` / `userInvocable` → 抛错 `frontmatter field "X" is unsupported; use "Y"`。
无 frontmatter、缺 `name`/`description`、名字非法、YAML 失败 → 记警告跳过。
bundle 的相对资源基底是 `<name>/` 目录；渲染给模型用 `renderSkillContent(skill)` 得到规范 `<skill_content>` 块。

---

## 6. Agent 循环钩子

`dsh-agent` 在 cordis 的 `Events` 上声明钩子。**没有** `agent/post-step`，也**没有** `agent/post-tool`：步骤结束是会话日志事件
`step/end`；工具结果观测用 `tools/result`（管线）或会话事件 `tool/result`（日志）。

### 6.1 `agent/pre-step`（注入消息 / 拒绝步骤）—— 完整示例

```ts
'agent/pre-step'(
  this: Scoped<Agent>,
  payload: { agent: Agent; messages: UserMessage[]; turn: number; step: number; signal: AbortSignal },
  next: () => Promise<PreStepDecision>,
): Promise<PreStepDecision>

type PreStepDecision = { kind: 'reject' } | { kind: 'enter'; messages: UserMessage[]; startsRequestSeries?: true }
```

`next()` 保持当前 messages；返回值替换进入该步骤的消息，或拒绝该步骤（mode `waterfall`，按 agent 作用域过滤派发）。
注入物必须是 `UserMessage`：`{ id, role: 'user', content: ContentBlock[], source }`，`source` 用
`{ kind: 'plugin', plugin: '<name>' } & ContextFormed`（`form: 'instructions' | 'catalog' | 'snapshot' | 'notice' | 'relay' | 'recall'`）。

```ts
import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'

export function registerPreStep(ctx: Context, buildCard: (cwd: string) => Promise<string | undefined>): void {
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || payload.signal.aborted) return decision
    const cwd = payload.agent.session.header.cwd
    if (cwd === undefined) return decision
    const note = await buildCard(cwd)                    // 你自己决定"注什么、何时注"
    if (note === undefined) return decision
    return {
      kind: 'enter',
      messages: [...decision.messages, {
        id: randomUUID(), role: 'user', content: [{ type: 'text', text: note }],
        source: { kind: 'plugin', plugin: 'my-plugin', form: 'snapshot', sections: [{ name: 'my-plugin', text: note }] },
      }],
    }
  }, { prepend: true })
}
```

若 bundle 不依赖 `@deepseek-ai/dsh-agent` 类型（本插件的处境），可把 `ctx.on` 断言成
`(name: string, listener: (payload: unknown, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision>) => unknown`，
再手动收窄 payload。

### 6.2 `tools/pre-execute`（否决 / 审批）—— 完整示例

```ts
'tools/pre-execute'(
  this: Scoped<ToolRuntime>,
  exec: ToolExecution,
  next: () => Promise<PreToolDecision>,
): Promise<PreToolDecision>

type PreToolDecision = { kind: 'allow' } | { kind: 'deny'; reason: string } | { kind: 'ask'; reason?: string }
```

`next()` 委托为 allow；缺失审批服务时 `ask` 降级为拒绝；参数**不可改写**（`exec.arguments` 已入日志）。
异步门禁必须观测 `exec.signal`（注册表在门禁结算后重新检查取消）。
单调否决请用 `ctx.tools.guard(fn)`：同步、只能拒绝、不能被后续监听器翻回允许。

```ts
import type { Context } from '@deepseek-ai/cordis'

const FORBIDDEN = new Set(['my_dangerous_tool'])

export function registerToolGate(ctx: Context): void {
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (FORBIDDEN.has(exec.name)) return { kind: 'deny', reason: `tool "${exec.name}" is disabled by my-plugin` }
    if (exec.name === 'write') return { kind: 'ask', reason: 'my-plugin requires approval for writes' }
    return next()
  })
  ctx.tools.guard((exec) => (FORBIDDEN.has(exec.name) ? 'blocked by my-plugin policy' : undefined))
}
```

### 6.3 同族事件

```ts
'tools/execute'(exec: ToolDispatchExecution, next: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult>
'tools/post-execute'(exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>): Promise<PostToolDecision>
'tools/result'(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): undefined        // emit
'tools/change'(): void                                                                                // emit
'tools/ptc-dispatch-log'(dispatch: PtcDispatchLog, next: () => Promise<ContentBlock[]>): Promise<ContentBlock[]>
'agent/session-start'({ agent: Agent; source: 'startup' | 'resume' | 'clear' | 'compact' }): void
'agent/turn-stopping'({ agent: Agent; turn: number; signal: AbortSignal }): Promise<void> | void      // serial
'agent/created' | 'agent/disposed'({ agent: Agent }): void
'agent/status'({ agent: Agent; status: 'idle' | 'running' }): void
'agent/request'({ agent; turn; step; signal }, next: () => Promise<LlmCallConfig>): Promise<LlmCallConfig>
'agent/request-error'({ agent; turn; step; provider; failure; retryPolicy; signal }, next: () => Promise<RequestErrorAction>): Promise<RequestErrorAction>
'agent/error'({ agent: Agent; turn: number; step: number; error: unknown }): void
'commands/change'(): void;  'skills/change'(): void

type PostToolDecision =
  | { kind: 'accept'; content?: ContentBlock[]; value?: never; additionalContexts?: UserMessage[] }
  | { kind: 'accept'; value: JsonValue; content?: never; additionalContexts?: UserMessage[] }
  | { kind: 'block'; feedback: ContentBlock[]; additionalContexts?: UserMessage[] }
```

会话日志事件（`SessionEventMap`，经 `ctx.on('session/event', ...)` 观测）：`turn/start`、`turn/end`、`step/start`、`step/end`、
`user/message`、`system/message`、`assistant/message`、`assistant/attempt`、`tool/call`、`tool/result`。
所有带 `this: Scoped<Agent>` / `Scoped<ToolRuntime>` 的事件都按 agent 作用域过滤派发。

---

## 7. CLI：`@deepseek-ai/dsh`（profile 与插件安装）

### 7.1 本地安装的确切命令行

`dsh plugin` 是 **pnpm 的薄转发器**（`lib/plugin-Ddi42qoW.js`）：按需初始化 profile → 在 profile 目录执行
`spawnSync('pnpm', args, { cwd: profileDir, stdio: 'inherit' })` → 按安装结果校正 `dsh.profile.bundles`。

```sh
# 本地目录：相对路径会被锚定到"你执行 dsh 的目录"，而不是 profile 目录
dsh plugin --profile web add /abs/path/to/dsh-my-plugin
dsh plugin --profile web add ../dsh-my-plugin           # → <cwd>/../dsh-my-plugin
dsh plugin --profile web add file:../dsh-my-plugin      # file:/link: 前缀保留
dsh plugin --profile web add link:../dsh-my-plugin
dsh plugin --profile web remove dsh-my-plugin
dsh plugin --profile web install
dsh plugin --profile web why dsh-my-plugin
```

只有**相对路径规格**会被重写为绝对路径：`/^(?<prefix>(?:file|link):)?(?<path>\.{1,2}(?:[/\\].*)?)$/`；
绝对路径、registry 名、`git+`/`github:`、tarball 规格原样透传。pnpm 退出码非 0 → 只打印
`pnpm failed in profile directory <dir>`；参数形如 `^git\+|^github:|\.git(?:#|$)` 时另提示需在
`<profileDir>/pnpm-workspace.yaml` 的 `allowBuilds` 放行 prepare 脚本。`--profile` 是 `plugin` 的 `requiredOption`，
无参数报错，profile 名 `desktop` 被拒绝（Electron 独占）。**没有** `dsh plugin link` 子命令 —— 用 pnpm 的 `link:` 规格。

### 7.2 `dsh.bundle.patch` 如何被消费

```json
{ "dsh": { "bundle": { "patch": "./cordis.patch.yml" } } }
```

`dsh plugin` 跑完 pnpm 后调用 `reconcilePlugins(before, profileDir)`：遍历 `dependencies`，对每个包 `resolveBundleDir()`
并读 manifest，若 `dsh.bundle.patch !== undefined` 就把包名**追加**进 `dsh.profile.bundles`；不再声明或已从依赖移除的包移出列表。
未声明 `dsh.bundle` 的依赖只是普通依赖，并打印一条 `declares no dsh.bundle` 警告（不是错误）。校正基于**安装后的实际状态**
而非依赖 diff，因此 `update` 让某包获得 `dsh.bundle` 后会自动激活。profile 模板自带的内置 bundle 不是依赖，永不被改动。
`DshBundleManifest.patch` 是相对包目录的路径，`loadProfile` 解析为 `patchPath` 与 `patches: PatchOptions[]`。

### 7.3 `cordis.patch.yml` schema

文件是**顶层 YAML 数组**，元素为 `PatchOptions`（`@deepseek-ai/cordis-plugin-include`）：

```ts
interface PatchOptions {
  id?: string; insert?: EntryOptions[]; name?: string; config?: any
  group?: boolean | null; disabled?: boolean | null
  inject?: any; intercept?: any; isolate?: any
  [key: string]: any
}
interface EntryOptions {
  id: string        // 必填：包含树内稳定 id
  name: string      // 必填：模块说明符（相对名按配置目录解析，裸包名按 baseUrl）
  config?: any; group?: boolean | null; disabled?: boolean | null; inject?: Inject | null
}
```

语义（`applyEntryPatches`，逐字对齐 `dsh-app-boot/lib/index.js`）：

- 有 `insert`：带 `id` → 命中该 entry，要求它是 `group`，把 `insert` 追加进它的 `config` 数组；找不到 → 警告
  `patch insert: entry "X" not found`；非 group → 警告并跳过。无 `id` → 追加到**根数组**。
- 无 `insert`：`id` 必填；命中目标后，若给了 `name` 且与目标 `name` 不符 → 警告并跳过；否则把其余键逐个覆盖到目标。
- 输入永不被修改（`structuredClone`）；同一列表内后面的 patch 可命中前面 patch 插入的行；未命中任何行的 patch 只警告。

```yaml
# bundle 的最小 patch 层（dsh-thesis 的真实文件）
- insert:
    - id: ai-learning
name: dsh-thesis
      # config: { stateDir: .ai-learning }
---
- id: tools                    # 按 id 覆盖已有条目
  config: { mode: both }
- id: my-row
  disabled: true
```

### 7.4 profile 层叠顺序

以空 entry 列表为起点，依次叠加：① `dsh.profile.bundles` 中每个 bundle 的 `cordis.patch.yml`（按列表顺序）；
② profile 目录自己的 `cordis.patch.yml`（`PROFILE_PATCH_FILENAME`）；③ `$DSH_HOME/cordis.patch.yml`（home 级）；
④ `--patch <path>` 覆盖层（可重复，按给出顺序）。`patchReload: 'live' | 'startup'`：前者监视 profile 与 home 级 patch 文件
并事务性重放，后者只在启动时应用一次。`--dump-config` / `--dump-default-config` 可在不启动的情况下查看合成树。

### 7.5 运行时依赖解析与 "install farm" 兜底

- 共享兜底目录：`$DSH_HOME/profiles/node_modules`。`healProfilesModuleFallback()` 在每次 profile 启动时让它镜像
  **dsh 安装自身的依赖闭包**；普通 Node 写 symlink（junction），打包可执行文件在跨进程锁下写 ESM 代理。
- 因此插件对 `@deepseek-ai/*` 的运行时 `import` 会沿 Node 父目录行走落到 `$DSH_HOME/profiles/node_modules`，
  **无需自己安装 peer**（`@deepseek-ai/cordis` 即典型）。
- bundle 名解析**双锚**：先从 dsh 安装目录解析（保证 `@deepseek-ai/dsh-base` 永远来自同一安装），再从 profile 目录解析。
  pnpm 管理的 `profile/node_modules` 条目优先；profile 私有链接只补"仅被所选 bundle 携带"的包，且不影响别的 profile。
- 建议：`@deepseek-ai/cordis` 放 `peerDependencies`；安装闭包之外的包放 `dependencies`。
- **必须发布编译后的 JS**：dsh CLI 依赖中没有 TypeScript 运行时加载器（`tsx`/`jiti` 均不在 `@deepseek-ai/dsh` 与
  `dsh-app-boot` 的依赖中），`lib/bin.js` 是纯 ESM import。让 `main` 指向 `lib/index.js`，`exports` 同时给出 `types`
  与 `default`。源码执行（vite/tsx/plain ESM）只适用于在 dsh 仓库内用 `pnpm dsh` 的开发路径。

### 7.6 名称与字符规则

| 对象 | 规则 | 违反后果 |
|---|---|---|
| 命令名 | `/^[a-z][a-z0-9_-]*$/u` | 注册时 `TypeError` |
| skill 名 | `/^[a-z0-9]+(?:-[a-z0-9]+)*$/` | 注册时 `Error: invalid skill name "X"`；文件发现时警告跳过 |
| profile 名 | 非空、不含 `/` 或 `\`、非 `.`/`..`/`node_modules`、非 `desktop` | `Error: dsh: invalid profile name "X"` / CLI 拒绝 desktop |
| bundle 包名 | 必须是 Node 可解析的 npm 包名；作为 `dsh.profile.bundles` 项时必须声明 `dsh.bundle` | `profile bundle "X" declares no dsh.bundle in its package.json` |
| 工具名 | `run_code` 被 PTC 传输保留 | `tool name "run_code" is reserved ...` |
| Loader entry `id` | 包含树内稳定唯一、非空 | 由 Loader entry 树裁决 |

---

## 8. 无法确定的事项（含已检查的内容）

1. **工具名的字符文法**：`dsh-tools` 的 `register()` 只检查 `run_code` 保留名与同层重复，**没有**名字正则，`ToolSchema.name` 也无 brand；
   `dsh-tools/lib/index.js` 的 SDK 渲染注释甚至以 `zz-\u{1E4D0}x` 这类名字为合法输入举例。我在已安装产物中找不到工具名字符白名单。
   检查过：`dsh-tools/lib/index.js`（`register`、`defineTool`、`ts-types` 渲染）、`dsh-llm/lib/types/*.d.ts` 的 `ToolSchema`。
   实际约束来自模型 Function Calling 惯例与 `run_code` 保留名，无法从本产物给出权威正则。
2. **"插件名允许字符"没有独立校验器**：`dsh plugin` 把包名交给 pnpm，加载时靠 Node 模块解析；唯一相近的显式规则是 7.6 的
   profile 名与命令名。检查过：`dsh/lib/plugin-Ddi42qoW.js`、`dsh/lib/bin.js`、`dsh-app-boot/lib/index.js`、
   `dsh-host-plugin-inventory/lib/types/*.d.ts`、`dsh-client-ui-settings-plugins/lib/client.js`。
3. `ctx.fs` 的存在性检查与递归列举**确实不存在**（合约边界，非搜索遗漏）：抽象类成员即第 3 节列出的 13 个原语，
   README.zh.md 亦明写"只有十三个原语""`listDir` 只列出一层"。
4. **`agent/post-step` 不存在**：`dsh-agent` 事件表止于 `agent/turn-stopping`；对应观测点是 `step/end`。
   检查过 `dsh-agent/lib/types/runtime-types.d.ts` 全文 419 行。
5. `dsh plugin link` 子命令不存在（见 7.1）。
6. `ToolOutputError` 构造签名 `.d.ts` 与 `.js` 不一致（见 2.3）。
7. `defineTool` 的 `parameters` 在 README.zh.md 示例里长得像 JSON Schema，实际是 DSL 属性映射（见 2.1）。
