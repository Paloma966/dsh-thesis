/**
 * 开发期类型声明（shims）——dsh-thesis 的唯一类型来源之一。
 *
 * 设计取舍（记录在 DESIGN.md ADR-8）：
 * 运行期这些能力全部来自 DSH 安装本体的真实包（cordis / dsh-tools / dsh-fs /
 * dsh-commands / dsh-agent / dsh-llm），由 profile 的扁平 node_modules 解析；
 * 本文件只在**编译期**提供插件实际使用到的最小表面，使本仓库不依赖任何
 * `@deepseek-ai/*` 的 npm 安装即可 `tsc` 通过（离线可构建、可评审）。
 *
 * 因此这里的签名刻意保持宽松（工具参数/渲染值取 `any`）：目标是让类型检查
 * 抓得到本插件自身的错误，而不是复刻宿主内部泛型。宿主契约的真实性由
 * `tests/` 的真实磁盘端到端 + 真实 `dsh plugin add` 装载验证兜底。
 *
 * 唯一例外是 `@deepseek-ai/schemastery`：Config schema 的 `z<Config>` 双重
 * 含义（值 + 类型）无法用宽松声明伪造，故作为唯一 devDependency 真实安装。
 */

declare module '@deepseek-ai/cordis' {
  /** Cordis 服务基类：`super(ctx, name)` 即完成自我注册。 */
  export class Service {
    constructor(ctx: Context, name: string)
    readonly ctx: Context
  }

  export interface Logger {
    debug(...args: unknown[]): void
    info(...args: unknown[]): void
    warn(...args: unknown[]): void
    error(...args: unknown[]): void
  }

  export interface Context {
    readonly tools: import('@deepseek-ai/dsh-tools').ToolRegistry
    readonly fs: import('@deepseek-ai/dsh-fs').FileSystem
    readonly commands: import('@deepseek-ai/dsh-commands').CommandRegistry
    readonly logger: Logger
    /** 注册一个服务（如 `ctx.provide('memory', service)`）。 */
    provide(name: string, value: unknown): void
    /** 读取一个已注册服务；未装配时返回 undefined。 */
    get(name: string): unknown
    /** 注册副作用清理回调；随插件 fiber 卸载。 */
    effect(callback: () => (() => void) | void, label?: string): void
    /** 订阅宿主事件（waterfall 监听器接收 `(payload, next)`）。 */
    on(event: string, listener: (...args: any[]) => any, options?: { prepend?: boolean }): unknown
    emit(event: string, ...args: unknown[]): void
  }
}

declare module '@deepseek-ai/dsh-tools' {
  export interface ToolRegistry {
    register(definition: unknown): () => void
  }

  /** 工具执行上下文：模型工具调用时由宿主注入。 */
  export interface ToolExecution {
    readonly signal: AbortSignal
    readonly agent?: {
      readonly session: {
        readonly header: {
          readonly cwd?: string
        }
      }
    }
  }

  /** `tools/pre-execute` 的决策：放行（委托 next）或以 ask 拦下等人类拍板。 */
  export type PreToolDecision =
    | { kind: 'allow' }
    | { kind: 'ask'; reason: string }
    | { kind: 'deny'; reason: string }

  export interface ToolDefinition {
    readonly name: string
    readonly description: string
    readonly parameters: Record<string, unknown>
    readonly output: {
      readonly schema: Record<string, unknown>
      readonly render: (args: any, value: any) => Array<{ type: 'text'; text: string }>
    }
    execute(args: any, exec: ToolExecution): Promise<any>
  }

  export function defineTool(definition: ToolDefinition): unknown
}

declare module '@deepseek-ai/dsh-fs' {
  /** 文件服务的目标句柄（对插件不透明）。 */
  export interface FsTarget {
    readonly displayPath: string
  }

  export interface FsDirEntry {
    readonly name: string
    readonly isDirectory: boolean
  }

  export interface FsInfo {
    readonly isDirectory: boolean
    readonly size: number
    readonly version?: unknown
  }

  export interface FileSystem {
    resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget>
    readText(target: FsTarget, signal?: AbortSignal): Promise<string>
    writeText(target: FsTarget, content: string, expected?: unknown, signal?: AbortSignal, sandboxPolicy?: unknown): Promise<{ version?: unknown }>
    listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]>
    stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined>
  }
}

declare module '@deepseek-ai/dsh-commands' {
  export interface CommandInvocation {
    readonly commandId: string
    readonly agent: {
      readonly session: {
        readonly header: {
          readonly cwd?: string
        }
      }
    }
    readonly rawInput: string
    readonly signal: AbortSignal
  }

  export type CommandResult =
    | { readonly kind: 'success'; readonly text?: string }
    | { readonly kind: 'error'; readonly text: string }

  export interface CommandRegistry {
    register(definition: unknown): () => void
  }
}

declare module '@deepseek-ai/dsh-agent' {
  export interface PreStepMessage {
    readonly source: { readonly kind: string }
    readonly content: unknown
  }

  export interface PreStepPayload {
    readonly messages: readonly PreStepMessage[]
    readonly agent?: unknown
    readonly signal?: AbortSignal
  }

  /** `agent/pre-step` 的 waterfall 决策：允许进入该步（可追加消息）或拒绝。 */
  export type PreStepDecision =
    | { kind: 'enter'; messages: unknown[] }
    | { kind: 'reject'; reason?: string }
}

declare module '@deepseek-ai/dsh-llm' {
  export interface ContentBlock {
    readonly type: string
    readonly text?: string
  }

  export interface MessageSource {
    readonly kind: string
    readonly plugin?: string
    readonly form?: string
    readonly sections?: Array<{ readonly name: string; readonly text: string }>
  }

  export interface UserMessage {
    readonly id: string
    readonly role: 'user'
    readonly content: ContentBlock[]
    readonly source: MessageSource
  }

  export function createUserMessage(input: {
    content: ContentBlock[]
    source?: MessageSource
    id?: string
  }): UserMessage
}

// ---------------------------------------------------------------------------
// Node 内置模块的最小类型面（替代 @types/node；tsconfig 用 types: [] 不引入
// 任何 @types 包）。只声明本插件实际用到的符号，签名与 Node 文档一致。
// ---------------------------------------------------------------------------

declare module 'node:path' {
  export function join(...paths: string[]): string
  export function resolve(...paths: string[]): string
  export function dirname(path: string): string
  export function basename(path: string, suffix?: string): string
  export function extname(path: string): string
  export function relative(from: string, to: string): string
  export function isAbsolute(path: string): boolean
  export function normalize(path: string): string
  export const sep: string
}

declare module 'node:fs' {
  export function mkdirSync(path: string, options?: { recursive?: boolean }): string | undefined
  export function mkdtempSync(prefix: string): string
  export function existsSync(path: string): boolean
  export function statSync(path: string): { readonly size: number; isDirectory(): boolean }
  export function readFileSync(path: string, encoding: string): string
  export function writeFileSync(path: string, data: string | Uint8Array): void
  export function rmSync(path: string, options?: { force?: boolean; recursive?: boolean }): void
}

declare module 'node:fs/promises' {
  export function writeFile(path: string | URL, data: string | Uint8Array, encoding?: string): Promise<void>
  export function readFile(path: string | URL, encoding: string): Promise<string>
  export function readFile(path: string | URL): Promise<Uint8Array>
  export function readdir(path: string | URL, options?: { withFileTypes?: boolean }): Promise<any[]>
  export function rm(path: string | URL, options?: { force?: boolean; recursive?: boolean }): Promise<void>
  export function mkdir(path: string | URL, options?: { recursive?: boolean }): Promise<string | undefined>
  export function stat(path: string | URL): Promise<{ isDirectory(): boolean; size: number }>
}

declare module 'node:url' {
  export function fileURLToPath(url: any): string
  export function pathToFileURL(path: string): URL
}

declare module 'node:child_process' {
  export interface SpawnSyncReturns {
    readonly status: number | null
    readonly stdout: string | null
    readonly stderr: string | null
    readonly error?: Error
  }
  export function spawnSync(command: string, args?: string[], options?: {
    cwd?: string
    encoding?: string
    timeout?: number
    maxBuffer?: number
    /** 受限环境下管道 stdio 可能被拒（EPERM）；插件默认用 'ignore'。 */
    stdio?: string
  }): SpawnSyncReturns
}

declare module 'node:crypto' {
  export interface Hash {
    update(data: string | Uint8Array): Hash
    digest(encoding: string): string
  }
  export function createHash(algorithm: string): Hash
  export function randomUUID(): string
}

declare module 'node:os' {
  export function tmpdir(): string
  export function homedir(): string
}

declare module 'node:zlib' {
  /** 解压 raw DEFLATE 流（OOXML 的 ZIP 条目压缩方式）。 */
  export function inflateRawSync(data: Uint8Array, options?: { maxOutputLength?: number }): Uint8Array
}

declare module 'node:sqlite' {
  export interface StatementSync {
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint }
    get(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
  }
  export class DatabaseSync {
    constructor(path: string, options?: { open?: boolean; readOnly?: boolean })
    exec(sql: string): void
    prepare(sql: string): StatementSync
    close(): void
  }
}

// ---------------------------------------------------------------------------
// 运行时全局（Node 平台提供；用最小声明替代 @types/node 全局面）。
// ---------------------------------------------------------------------------

interface AbortSignal {
  readonly aborted?: boolean
  readonly reason?: unknown
}

declare var AbortSignal: {
  timeout(ms: number): AbortSignal
  any(signals: AbortSignal[]): AbortSignal
}

interface Response {
  readonly ok: boolean
  readonly status: number
  json(): Promise<unknown>
  text(): Promise<string>
}

declare function fetch(url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }): Promise<Response>

interface URL {
  readonly href: string
  toString(): string
}

declare var URL: {
  new (input: string | URL, base?: string | URL): URL
}

interface URLSearchParams {
  set(name: string, value: string): void
  toString(): string
}

declare var URLSearchParams: {
  new (init?: Record<string, string>): URLSearchParams
}

interface TextEncoder {
  encode(input?: string): Uint8Array
}

declare var TextEncoder: {
  new (): TextEncoder
}

interface TextDecoder {
  decode(input?: Uint8Array): string
}

declare var TextDecoder: {
  new (label?: string): TextDecoder
}

declare var process: {
  readonly pid: number
  readonly platform: string
  readonly env: Record<string, string | undefined>
  cwd(): string
}

/**
 * 控制台。插件内的日志应走 `ctx.logger`（归属于宿主会话），
 * 这里声明它是为了测试脚本与极少数诊断路径可用。
 */
declare var console: {
  log(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

interface ImportMeta {
  readonly url: string
}
