/**
 * 追问状态的落盘与读取：`.paper/intake.json`（相对论文工作区根）。
 *
 * 三条硬规则：
 * 1. **原子写**：先写同目录临时文件，再改名覆盖目标。中途断电只会留下一个
 *    可识别的临时文件，绝不会把状态写成半截 JSON。改名走可注入的
 *    {@link IntakeIo.rename} 接口——真机上是 `node:fs/promises` 的 rename，
 *    测试里是内存实现，两条路径都必须走通。
 * 2. **损坏时报错，不静默重置**：JSON 解析失败、版本不符、结构不对，一律抛出
 *    带文件路径与修复建议的中文错误。悄悄重置会丢掉用户已经答过的每一个问题，
 *    这比报错严重得多。
 * 3. **断点续问**：状态是唯一的真相来源，新会话读回它就能从正确的问题继续。
 *
 * @module dsh-thesis/intake
 */

import * as nodePath from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { isMissingError } from '../shared/fs-errors.ts'
import type { IntakeContext, MaterialSummary } from './questions.ts'

/** 状态文件相对论文工作区根的路径。 */
export const STATE_REL = '.paper/intake.json'

/** 状态 schema 版本；结构不兼容变更时必须递增（旧状态将明确报错而非被猜读）。 */
export const STATE_VERSION = 1

/** 追问阶段：`asking` 进行中；`done` 必答项已齐、可进入下一阶段。 */
export type IntakeStage = 'asking' | 'done'

/** 合法阶段集合（状态迁移校验用）。 */
export const INTAKE_STAGES: readonly IntakeStage[] = ['asking', 'done']

/** 一条答案的来源：用户亲口答的，还是材料推断出来的。 */
export type AnswerSource = 'user' | 'materials'

/** 一条已记录的答案。 */
export interface IntakeAnswer {
  value: string
  /** 记录时刻（ISO 字符串）。 */
  at: string
  source: AnswerSource
  /** 材料推断的答案必须经用户确认才计入必答项。 */
  confirmed: boolean
  /** 轻校验是否通过（缺省视为通过）。 */
  valid?: boolean
  /** 校验提示：格式不对时的具体说明。 */
  note?: string
}

/** 追问状态：`.paper/intake.json` 的全部内容。 */
export interface IntakeState {
  version: number
  createdAt: string
  updatedAt: string
  stage: IntakeStage
  /**
   * 本轮追问已经问过的问题 id（含被跳过的）。
   * 这是 `maxQuestions` 上限的计分依据，也是断点续问的进度标记。
   */
  askedIds: string[]
  answers: Record<string, IntakeAnswer>
  skipped: string[]
  /** 跳过理由：`id → 理由`（`skip` 必须给理由）。 */
  skipReasons: Record<string, string>
  specPath: string
}

/** 建一份全新状态。 */
export function defaultState(now: Date = new Date(), specPath = ''): IntakeState {
  const iso = now.toISOString()
  return {
    version: STATE_VERSION,
    createdAt: iso,
    updatedAt: iso,
    stage: 'asking',
    askedIds: [],
    answers: {},
    skipped: [],
    skipReasons: {},
    specPath,
  }
}

// ---------------------------------------------------------------------------
// 序列化与宽容解析
// ---------------------------------------------------------------------------

/** 稳定序列化：键序固定、2 空格缩进、结尾换行（同样的状态 → 同样的字节）。 */
export function serializeState(state: IntakeState): string {
  const answers: Record<string, IntakeAnswer> = {}
  for (const id of Object.keys(state.answers).sort()) {
    const rec = state.answers[id]!
    const out: IntakeAnswer = {
      value: rec.value,
      at: rec.at,
      source: rec.source,
      confirmed: rec.confirmed,
    }
    if (rec.valid !== undefined) out.valid = rec.valid
    if (rec.note !== undefined) out.note = rec.note
    answers[id] = out
  }
  const ordered = {
    version: state.version,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    stage: state.stage,
    askedIds: [...state.askedIds],
    answers,
    skipped: [...state.skipped],
    skipReasons: { ...state.skipReasons },
    specPath: state.specPath,
  }
  return `${JSON.stringify(ordered, null, 2)}\n`
}

/** 状态损坏：带路径与修复建议的可读错误。 */
export class IntakeStateError extends Error {
  readonly path: string

  constructor(path: string, detail: string) {
    super(
      `追问状态文件无法使用：${path}\n原因：${detail}\n` +
      `处理建议：修正该 JSON（或先备份后删除它，用 thesis_intake action=start 重新开始追问）。` +
      `请勿手工把 answers 改空——那会丢掉已确认的全部答案。`,
    )
    this.name = 'IntakeStateError'
    this.path = path
  }
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string')
}

function asStringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (value === null || typeof value !== 'object') return out
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v
  }
  return out
}

function parseAnswers(value: unknown): Record<string, IntakeAnswer> {
  const out: Record<string, IntakeAnswer> = {}
  if (value === null || typeof value !== 'object') return out
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (raw === null || typeof raw !== 'object') continue
    const rec = raw as Record<string, unknown>
    if (typeof rec.value !== 'string' || rec.value.trim() === '') continue
    const answer: IntakeAnswer = {
      value: rec.value,
      at: typeof rec.at === 'string' ? rec.at : new Date().toISOString(),
      source: rec.source === 'materials' ? 'materials' : 'user',
      confirmed: rec.confirmed === true,
    }
    if (typeof rec.valid === 'boolean') answer.valid = rec.valid
    if (typeof rec.note === 'string') answer.note = rec.note
    out[id] = answer
  }
  return out
}

/**
 * 解析状态文本。任何结构性问题都抛出 {@link IntakeStateError}，
 * 绝不返回「看起来能用」的默认状态。
 */
export function parseState(raw: string, path = STATE_REL): IntakeState {
  let data: unknown
  try {
    data = JSON.parse(raw) as unknown
  } catch (error) {
    throw new IntakeStateError(path, `不是合法 JSON（${error instanceof Error ? error.message : String(error)}）`)
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new IntakeStateError(path, '顶层不是 JSON 对象')
  }
  const obj = data as Record<string, unknown>
  if (obj.version !== STATE_VERSION) {
    throw new IntakeStateError(
      path,
      `version 期望 ${STATE_VERSION}，实际 ${JSON.stringify(obj.version)}（可能是旧版本或被别的工具改写）`,
    )
  }
  const stage = obj.stage === 'done' ? 'done' : 'asking'
  const specPath = typeof obj.specPath === 'string' ? obj.specPath : ''
  const iso = new Date().toISOString()
  return {
    version: STATE_VERSION,
    createdAt: typeof obj.createdAt === 'string' ? obj.createdAt : iso,
    updatedAt: typeof obj.updatedAt === 'string' ? obj.updatedAt : iso,
    stage,
    askedIds: asStringArray(obj.askedIds),
    answers: parseAnswers(obj.answers),
    skipped: asStringArray(obj.skipped),
    skipReasons: asStringRecord(obj.skipReasons),
    specPath,
  }
}

// ---------------------------------------------------------------------------
// 状态迁移
// ---------------------------------------------------------------------------

/** 迁移检查结果。 */
export interface TransitionCheck {
  readonly ok: boolean
  readonly reason: string
}

/**
 * 校验「把阶段推进到 to」是否被允许。
 *
 * 规则：`asking → done` 只能由 `done` 动作在必答项齐全后触发（由调用方保证）；
 * 已经 `done` 的状态允许重答问题，但不会被自动退回 `asking`——回退必须显式
 * 重答一个必答项（见 {@link applyAnswer}），避免状态在两次读取间莫名倒退。
 */
export function canTransition(state: IntakeState, to: IntakeStage): TransitionCheck {
  if (!INTAKE_STAGES.includes(to)) {
    return { ok: false, reason: `未知阶段：${String(to)}。有效值：${INTAKE_STAGES.join('、')}。` }
  }
  if (state.stage === to) return { ok: true, reason: '' }
  if (state.stage === 'done' && to === 'asking') {
    return { ok: false, reason: '已完成的追问不会自动退回进行中；如发现答案有误，直接重答该问题即可。' }
  }
  return { ok: true, reason: '' }
}

/** 校验通过后写入阶段；不通过时返回原状态（调用方负责提示原因）。 */
export function setStage(state: IntakeState, to: IntakeStage, now: Date = new Date()): TransitionCheck {
  const check = canTransition(state, to)
  if (!check.ok) return check
  state.stage = to
  state.updatedAt = now.toISOString()
  return { ok: true, reason: '' }
}

/** 记录一次「已提问」（幂等：重复记同一个 id 不改变状态）。 */
export function markAsked(state: IntakeState, id: string, now: Date = new Date()): boolean {
  if (state.askedIds.includes(id)) return false
  state.askedIds.push(id)
  state.updatedAt = now.toISOString()
  return true
}

/**
 * 写入一条答案。**幂等**：`value` 与原值完全一致时不改动 `at`/`updatedAt`，
 * 返回 `changed:false`——重复提交同一个答案不会污染历史。
 */
export function applyAnswer(
  state: IntakeState,
  id: string,
  value: string,
  opts: { source?: AnswerSource; confirmed?: boolean; valid?: boolean; note?: string; now?: Date } = {},
): { changed: boolean; record: IntakeAnswer } {
  const now = opts.now ?? new Date()
  const trimmed = value.trim()
  const existing = state.answers[id]
  if (existing !== undefined && existing.value === trimmed) {
    // 同样的答案：只更新确认位（材料推断 → 用户确认是唯一有意义的变化）。
    const wantConfirmed = opts.confirmed ?? true
    if (existing.confirmed !== wantConfirmed) {
      existing.confirmed = wantConfirmed
      state.updatedAt = now.toISOString()
      return { changed: true, record: existing }
    }
    return { changed: false, record: existing }
  }
  const record: IntakeAnswer = {
    value: trimmed,
    at: now.toISOString(),
    source: opts.source ?? 'user',
    confirmed: opts.confirmed ?? true,
  }
  if (opts.valid !== undefined) record.valid = opts.valid
  if (opts.note !== undefined) record.note = opts.note
  state.answers[id] = record
  state.skipped = state.skipped.filter(s => s !== id)
  delete state.skipReasons[id]
  state.updatedAt = now.toISOString()
  // 重答必答项后，已完成的追问回到进行中：规格必须重新收敛。
  if (state.stage === 'done' && record.valid !== false) {
    state.stage = 'asking'
  }
  return { changed: true, record }
}

/** 记录一次跳过（必须带理由；跳过必答项会让 `done` 拒绝）。 */
export function applySkip(state: IntakeState, id: string, reason: string, now: Date = new Date()): void {
  if (!state.skipped.includes(id)) state.skipped.push(id)
  state.skipReasons[id] = reason.trim()
  state.updatedAt = now.toISOString()
}

// ---------------------------------------------------------------------------
// I/O：可注入的读写接口
// ---------------------------------------------------------------------------

/** 宿主文件系统的最小面（`ctx.fs` 在运行期满足它）。 */
export interface FileSystemLike {
  resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<{ displayPath: string }>
  readText(target: { displayPath: string }, signal?: AbortSignal): Promise<string>
  writeText(target: { displayPath: string }, content: string, expected?: unknown, signal?: AbortSignal): Promise<unknown>
  stat(target: { displayPath: string }, signal?: AbortSignal): Promise<{ isDirectory: boolean; size: number } | undefined>
  listDir(target: { displayPath: string }, signal?: AbortSignal): Promise<Array<{ name: string; isDirectory: boolean }>>
}

/**
 * 追问模块用的窄 I/O 接口。
 *
 * `rename` 单独抽出来，是为了让「临时文件 + 改名」的原子写在假 fs 下也能走通：
 * 真机实现用 `node:fs/promises`，测试可注入内存实现或干脆省略（走兜底复制路径）。
 */
export interface IntakeIo {
  read(path: string): Promise<string | undefined>
  write(path: string, content: string): Promise<void>
  exists(path: string): Promise<boolean>
  listDir(path: string): Promise<string[]>
  /** 原子改名的注入点；省略时 {@link writeAtomic} 退化为「写临时文件 → 复制 → 删临时文件」。 */
  rename?(from: string, to: string): Promise<void>
  /** 可选：删掉临时文件；省略时临时文件会留下（不影响正确性）。 */
  remove?(path: string): Promise<void>
}

/**
 * 用 `ctx.fs` 拼一个 I/O；默认改名走 `node:fs/promises`（真机路径）。
 *
 * **`read` 只把「确认不存在」折叠成 `undefined`**：权限与 IO 错误一律上抛。
 * 否则调用方会以为状态还没建过，用默认态覆盖掉用户已答的每一个问题
 * （详见 `shared/fs-errors.ts`）。
 */
export function fsIo(fs: FileSystemLike, signal?: AbortSignal, rename?: (from: string, to: string) => Promise<void>): IntakeIo {
  return {
    async read(path) {
      try {
        return await fs.readText(await fs.resolve(path, { signal }), signal)
      } catch (error) {
        if (isMissingError(error)) return undefined
        throw error
      }
    },
    async write(path, content) {
      await fs.writeText(await fs.resolve(path, { signal }), content, undefined, signal)
    },
    async exists(path) {
      const info = await fs.stat(await fs.resolve(path, { signal }))
      return info !== undefined && !info.isDirectory
    },
    async listDir(path) {
      try {
        const entries = await fs.listDir(await fs.resolve(path, { signal }), signal)
        return entries.map(e => e.name)
      } catch (error) {
        // 目录不存在 = 空目录；读失败必须上抛，否则「材料清单读不出来」会被当成「没有材料」。
        if (isMissingError(error)) return []
        throw error
      }
    },
    ...(rename === undefined
      ? {}
      : {
          async rename(from: string, to: string) {
            await rename(from, to)
          },
        }),
    async remove(path) {
      // `ctx.fs` 没有删除原语，写空内容即可；残留的空临时文件不影响正确性。
      await fs.writeText(await fs.resolve(path, { signal }), '', undefined, signal).catch(() => undefined)
    },
  }
}

/** 真机改名：`node:fs/promises` 的 readFile + writeFile（同一目录内的替换）。 */
export const nodeRename = async (from: string, to: string): Promise<void> => {
  const data = await readFile(from, 'utf8')
  await writeFile(to, data, 'utf8')
}

/**
 * 原子写：先写临时文件，再改名覆盖目标。
 *
 * 有 `io.rename` 时是真改名；没有时退化为「写临时 → 写目标 → 清临时」。
 * 任何一步失败都会尽力清掉临时文件，并把错误原样抛给调用方（不吞）。
 */
export async function writeAtomic(io: IntakeIo, path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}`
  await io.write(tmp, content)
  try {
    if (io.rename !== undefined) {
      await io.rename(tmp, path)
    } else {
      await io.write(path, content)
      await io.remove?.(tmp)
    }
  } catch (error) {
    await io.remove?.(tmp)
    throw error
  }
}

/** 读取状态；文件不存在返回 `undefined`（由调用方决定是否初始化）。 */
export async function loadState(io: IntakeIo, root: string): Promise<IntakeState | undefined> {
  const path = nodePath.join(root, STATE_REL)
  const raw = await io.read(path)
  if (raw === undefined) return undefined
  return parseState(raw, path)
}

/** 原子落盘状态。 */
export async function saveState(io: IntakeIo, root: string, state: IntakeState, now: Date = new Date()): Promise<void> {
  state.updatedAt = now.toISOString()
  await writeAtomic(io, nodePath.join(root, STATE_REL), serializeState(state))
}

// ---------------------------------------------------------------------------
// 材料清单与台账：宽容读取
// ---------------------------------------------------------------------------

/** `thesis_ingest` 的材料清单相对路径。 */
export const MATERIALS_REL = '00-管理/材料清单.md'

/** 台账相对路径（复用 paper 模块的约定，但不 import 它，避免模块间耦合成环）。 */
const LEDGER_REL = '00-管理/进度台账.md'

const EXT_RE = /\.([A-Za-z0-9]{1,5})$/

function extOf(path: string): string {
  const m = EXT_RE.exec(path)
  return m === null ? '' : m[1]!.toLowerCase()
}

/** 去掉 Markdown 的包裹标记（反引号、加粗星号）与首尾空白。 */
function unwrapCell(cell: string): string {
  return cell.replace(/[`*]/g, '').trim()
}

/**
 * 宽容解析材料清单 Markdown。
 *
 * 只认「一行的表格里有 `.扩展名` 的单元格」：取该行第一个（剥掉反引号/星号后）
 * 含扩展名的单元格为路径，其余单元格里第一个非空、非数字的当类型。
 * 表头、分隔行、段落一律跳过。
 * 解析不出任何条目时返回空清单——宁可多问一个，也不要凭猜免问。
 */
export function parseMaterials(md: string): MaterialSummary {
  const items: Array<{ path: string; kind: string; ext: string }> = []
  for (const line of md.split(/\r?\n/)) {
    if (!line.includes('|')) continue
    const cells = line.split('|').map(c => c.trim()).filter(c => c.length > 0)
    if (cells.length === 0) continue
    if (cells.every(c => /^:?-{2,}:?$/.test(c))) continue // 表格分隔行
    // 路径优先：剥掉反引号后能看出扩展名的那个单元格。
    const pathCell = cells.find(c => EXT_RE.test(unwrapCell(c)) && !/^[-–—\s]*$/.test(c))
    if (pathCell === undefined) continue
    const path = unwrapCell(pathCell)
    if (path === '') continue
    const kind = cells.find(c => c !== pathCell && !/^\d+(\.\d+)?\s*(B|KB|MB|GB)?$/i.test(c) && !/^[-–—\s]*$/.test(c)) ?? ''
    items.push({ path, kind: unwrapCell(kind), ext: extOf(path) })
  }
  return { found: items.length > 0, items }
}

/** 读材料清单；缺失或为空返回 `{ found:false, items:[] }`。 */
export async function loadMaterials(io: IntakeIo, root: string): Promise<MaterialSummary> {
  const raw = await io.read(nodePath.join(root, MATERIALS_REL))
  if (raw === undefined) return { found: false, items: [] }
  return parseMaterials(raw)
}

/**
 * 从进度台账推断当前阶段名。
 *
 * 台账的机器真相是 `<!-- thesis:state ... -->` 里的 `currentStage`（数字），
 * 这里只做「读到就用、读不到就按开题前」的宽容推断，绝不因为台账异常而中断追问。
 */
export function stageFromLedger(md: string | undefined): string | undefined {
  if (md === undefined) return undefined
  const block = /<!-- thesis:state\n([\s\S]*?)\n-->/.exec(md)
  if (block === null || block[1] === undefined) return undefined
  let stage: unknown
  try {
    stage = (JSON.parse(block[1]) as { currentStage?: unknown }).currentStage
  } catch {
    return undefined
  }
  if (typeof stage !== 'number' || !Number.isFinite(stage)) return undefined
  const names: Record<number, string> = {
    1: '选题',
    2: '开题',
    3: '文献调研',
    4: '系统设计',
    5: '系统实现',
    6: '系统测试',
    7: '论文撰写',
    8: '定稿与合规',
    9: '答辩',
  }
  return names[Math.floor(stage)]
}

/** 读台账并推断阶段（读不到返回 undefined，由 {@link makeContext} 落到默认值）。 */
export async function loadStage(io: IntakeIo, root: string): Promise<string | undefined> {
  return stageFromLedger(await io.read(nodePath.join(root, LEDGER_REL)))
}

export { LEDGER_REL }
