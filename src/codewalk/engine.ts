/**
 * 代码演练引擎：一个普通类，由 `register.ts` 里的 `registerCodewalk`
 * 注册为 `paperLearn` 服务。
 *
 * 引擎负责守住流程，模型负责执行流程。所有非法迁移都在这里被拒绝：没有
 * 真实跑过一次验证门，模型就不能把某个里程碑标成 verified；不能修改已冻结
 * （verified）的里程碑；不能跳阶段。状态落在 `<cwd>/.paper/state.json`，
 * 因此跨会话存活，并随演练骨架仓库一起走。
 *
 * 这个类刻意**不**继承 Cordis 的 `Service`：装进 profile 的 bundle 会从自己的
 * 依赖树里解析 `@deepseek-ai/cordis`，两份模块副本会破坏框架以 Symbol 为键的
 * 生命周期钩子。注册一律走 `ctx.provide` —— 与生产 boot 插件用的是同一个接缝。
 *
 * @module dsh-thesis/codewalk
 */

import type { Context } from '@deepseek-ai/cordis'
import type { StateFileSystem } from './fs-types.ts'
import { LearningError } from './errors.ts'
import type {
  CreateStateInput,
  Difficulty,
  EngineStateSnapshot,
  GateOutcome,
  GateRecord,
  GateSpec,
  LearningState,
  LearnOptions,
  Milestone,
  MilestoneStatus,
  Phase,
  Question,
  QuestionStatus,
  Todo,
  TodoStatus,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    paperLearn: AiLearningEngine
  }
}

/** 已物化全部默认值的解析后配置。 */
export interface ResolvedConfig {
  readonly stateDir: string
  readonly gates: Readonly<Record<string, GateSpec>>
  readonly maxCapturedOutput: number
}

const PHASES: readonly Phase[] = ['analyzing', 'skeletonizing', 'learning', 'complete']

const PHASE_NEXT: Record<Phase, Phase | null> = {
  analyzing: 'skeletonizing',
  skeletonizing: 'learning',
  learning: 'complete',
  complete: null,
}

const TODO_STATUS: readonly TodoStatus[] = ['pending', 'in_progress', 'done']
const MILESTONE_STATUS: readonly MilestoneStatus[] = ['pending', 'in_progress', 'verified', 'failed']
const QUESTION_STATUS: readonly QuestionStatus[] = ['unasked', 'asked', 'passed', 'failed']
const DIFFICULTIES: readonly Difficulty[] = [1, 2, 3, 4]

/** 合法的 todo 状态迁移：允许返工（done → in_progress）。 */
const TODO_MOVES: Readonly<Record<TodoStatus, readonly TodoStatus[]>> = {
  pending: ['in_progress', 'done'],
  in_progress: ['done'],
  done: ['in_progress'],
}

/**
 * 代码演练引擎。
 *
 * 所有状态机方法都直接修改传入的 `state` 对象，并用 `LearningError` 拒绝非法
 * 迁移。持久化方法一律走注入的文件系统，因此本地与远端后端行为一致。
 */
export class AiLearningEngine {
  private readonly ctx: Context
  private readonly resolved: ResolvedConfig

  constructor(ctx: Context, config: LearnOptions = {}) {
    this.ctx = ctx
    this.resolved = {
      stateDir: config.stateDir ?? '.paper',
      gates: config.gates ?? { go: { build: ['go', 'build', './...'] } },
      maxCapturedOutput: config.maxCapturedOutput ?? 8000,
    }
  }

  /** 解析后的配置（默认值已物化）。 */
  get config(): ResolvedConfig {
    return this.resolved
  }

  /** 宿主文件系统接缝；`inject: ['fs']` 保证其存在。 */
  private get fs(): StateFileSystem {
    return this.ctx.get('fs') as unknown as StateFileSystem
  }

  private stateFilePath(): string {
    return `${this.resolved.stateDir}/state.json`
  }

  // ── 持久化 ───────────────────────────────────────────────────────────

  /** 相对会话 cwd 解析状态文件目标。 */
  async stateTarget(cwd: string): Promise<ReturnType<StateFileSystem['resolve']>> {
    return this.fs.resolve(this.stateFilePath(), { cwd })
  }

  /** `cwd` 下是否已存在演练状态。 */
  async hasState(cwd: string): Promise<boolean> {
    const target = await this.stateTarget(cwd)
    return (await this.fs.stat(target)) !== undefined
  }

  /**
   * 读取并校验 `cwd` 下的状态；不存在时返回 `undefined`。
   * 内容损坏时以 `STATE_INVALID` 拒绝。
   */
  async load(cwd: string): Promise<LearningState | undefined> {
    const target = await this.stateTarget(cwd)
    const info = await this.fs.stat(target)
    if (info === undefined) return undefined
    const text = await this.fs.readText(target)
    return parseState(text)
  }

  /**
   * 为一次新的代码演练创建初始状态。
   *
   * 已存在状态时以 `STATE_EXISTS` 拒绝（经 `createIfAbsent` 保证竞态安全）；
   * 源语言没有配置验证门时以 `GATE_UNKNOWN` 拒绝。
   */
  async create(cwd: string, input: CreateStateInput): Promise<LearningState> {
    const gate = this.resolved.gates[input.origin.language]
    if (gate === undefined) {
      throw new LearningError(
        'GATE_UNKNOWN',
        `语言 "${input.origin.language}" 没有配置验证门（已配置：${Object.keys(this.resolved.gates).join(', ') || '无'}）`,
      )
    }
    const target = await this.stateTarget(cwd)
    if ((await this.fs.stat(target)) !== undefined) {
      throw new LearningError('STATE_EXISTS', `${cwd} 下已存在演练状态`)
    }
    const state: LearningState = {
      schemaVersion: 1,
      phase: 'analyzing',
      origin: { path: input.origin.path, language: input.origin.language },
      scope: { ...input.scope },
      milestones: [],
      todos: [],
      gates: this.resolved.gates,
      records: [],
      updatedAt: Date.now(),
    }
    const content = serializeState(state)
    try {
      await this.fs.writeText(target, content, { createIfAbsent: true })
    } catch (error) {
      if (errorCode(error) === 'FS_NOT_OBSERVED') {
        throw new LearningError('STATE_EXISTS', `${cwd} 下已存在演练状态`)
      }
      throw error
    }
    return state
  }

  /** 持久化当前状态，并刷新 `updatedAt`。 */
  async save(cwd: string, state: LearningState): Promise<void> {
    validateStateShape(state)
    state.updatedAt = Date.now()
    const target = await this.stateTarget(cwd)
    await this.fs.writeText(target, serializeState(state))
  }

  // ── 阶段状态机 ───────────────────────────────────────────────────────

  /**
   * 推进工作流阶段。只允许沿
   * analyzing → skeletonizing → learning → complete 向前走。
   * 进入 `learning` 至少需要一个带 todo 的里程碑；
   * 进入 `complete` 需要每个里程碑都已 verified。
   */
  advancePhase(state: LearningState, next: Phase): void {
    if (next === state.phase) return
    if (PHASE_NEXT[state.phase] !== next) {
      throw new LearningError('ILLEGAL_TRANSITION', `不能从阶段 "${state.phase}" 迁移到 "${next}"`)
    }
    if (next === 'learning') {
      if (state.milestones.length === 0) {
        throw new LearningError('ILLEGAL_TRANSITION', '不能进入 learning 阶段：尚未定义任何里程碑')
      }
      for (const milestone of state.milestones) {
        if (milestone.todos.length === 0) {
          throw new LearningError('ILLEGAL_TRANSITION', `里程碑 "${milestone.id}" 没有任何 todo`)
        }
      }
    }
    if (next === 'complete') {
      const open = state.milestones.filter((milestone) => milestone.status !== 'verified')
      if (open.length > 0) {
        throw new LearningError(
          'ILLEGAL_TRANSITION',
          `不能完成：仍有未关闭的里程碑：${open.map((milestone) => milestone.id).join(', ')}`,
        )
      }
    }
    state.phase = next
    if (next === 'learning') this.startNextMilestone(state)
  }

  // ── todo 状态机 ──────────────────────────────────────────────────────

  /** 新增或替换一个 todo。被 verified 里程碑引用的 todo 已冻结。 */
  upsertTodo(state: LearningState, todo: Todo): void {
    if (!DIFFICULTIES.includes(todo.difficulty)) {
      throw new LearningError('ILLEGAL_TRANSITION', `todo "${todo.id}" 的难度值非法`)
    }
    if (!TODO_STATUS.includes(todo.status)) {
      throw new LearningError('ILLEGAL_TRANSITION', `todo "${todo.id}" 的状态值非法`)
    }
    this.assertTodoEditable(state, todo.id)
    const index = state.todos.findIndex((entry) => entry.id === todo.id)
    if (index >= 0) state.todos[index] = todo
    else state.todos.push(todo)
  }

  /** 沿 pending → in_progress → done 迁移一个 todo（允许返工）。 */
  setTodoStatus(state: LearningState, todoId: string, status: TodoStatus): void {
    const todo = state.todos.find((entry) => entry.id === todoId)
    if (todo === undefined) throw new LearningError('TODO_UNKNOWN', `未知 todo "${todoId}"`)
    if (status === todo.status) return
    if (!(TODO_MOVES[todo.status] as readonly TodoStatus[]).includes(status)) {
      throw new LearningError(
        'ILLEGAL_TRANSITION',
        `不能把 todo "${todoId}" 从 "${todo.status}" 迁移到 "${status}"`,
      )
    }
    todo.status = status
  }

  private assertTodoEditable(state: LearningState, todoId: string): void {
    const frozen = state.milestones.some(
      (milestone) => milestone.status === 'verified' && milestone.todos.includes(todoId),
    )
    if (frozen) {
      throw new LearningError('ILLEGAL_TRANSITION', `todo "${todoId}" 已被 verified 里程碑冻结`)
    }
  }

  // ── 里程碑状态机 ─────────────────────────────────────────────────────

  /**
   * 新增或替换一个里程碑。verified 里程碑已冻结。每个 todo 引用都必须能解析。
   * 新里程碑从 `pending` 开始；对未关闭里程碑做内容编辑会保留其当前状态。
   */
  upsertMilestone(state: LearningState, milestone: Milestone): void {
    const existing = state.milestones.find((entry) => entry.id === milestone.id)
    if (existing?.status === 'verified') {
      throw new LearningError('ILLEGAL_TRANSITION', `里程碑 "${milestone.id}" 已 verified，处于冻结状态`)
    }
    for (const todoId of milestone.todos) {
      if (!state.todos.some((todo) => todo.id === todoId)) {
        throw new LearningError('TODO_UNKNOWN', `里程碑 "${milestone.id}" 引用了未知 todo "${todoId}"`)
      }
    }
    for (const [index, question] of milestone.questions.entries()) {
      if (question.ask.trim() === '') {
        throw new LearningError('ILLEGAL_TRANSITION', `里程碑 "${milestone.id}" 的第 ${index} 个问题缺少提问文本`)
      }
      if (!QUESTION_STATUS.includes(question.status)) {
        throw new LearningError(
          'ILLEGAL_TRANSITION',
          `里程碑 "${milestone.id}" 的第 ${index} 个问题状态非法`,
        )
      }
    }
    const normalized: Milestone = {
      ...milestone,
      status: existing === undefined ? 'pending' : existing.status,
      questions: milestone.questions.map((question) => ({ ...question })),
    }
    if (existing === undefined) state.milestones.push(normalized)
    else {
      const index = state.milestones.indexOf(existing)
      if (index >= 0) state.milestones.splice(index, 1, normalized)
    }
  }

  /** 启动第一个 pending 里程碑。要求处于 learning 阶段。 */
  startNextMilestone(state: LearningState): void {
    if (state.phase !== 'learning') {
      throw new LearningError('ILLEGAL_TRANSITION', `阶段 "${state.phase}" 下不能启动里程碑`)
    }
    const next = state.milestones.find((milestone) => milestone.status === 'pending')
    if (next !== undefined) next.status = 'in_progress'
  }

  /** 重新打开一个 failed 里程碑，允许再试一次。 */
  retryMilestone(state: LearningState, milestoneId: string): void {
    const milestone = this.milestone(state, milestoneId)
    if (milestone.status !== 'failed') {
      throw new LearningError('ILLEGAL_TRANSITION', `里程碑 "${milestoneId}" 当前是 "${milestone.status}"，不是 failed`)
    }
    milestone.status = 'in_progress'
  }

  private milestone(state: LearningState, milestoneId: string): Milestone {
    const milestone = state.milestones.find((entry) => entry.id === milestoneId)
    if (milestone === undefined) throw new LearningError('MILESTONE_UNKNOWN', `未知里程碑 "${milestoneId}"`)
    return milestone
  }

  // ── 问答状态机 ───────────────────────────────────────────────────────

  /** 提出（或在失分后重提）某个里程碑问题。 */
  askQuestion(state: LearningState, milestoneId: string, questionIndex: number): void {
    const question = this.question(state, milestoneId, questionIndex)
    if (question.status === 'asked') return
    if (question.status !== 'unasked' && question.status !== 'failed') {
      throw new LearningError('ILLEGAL_TRANSITION', `第 ${questionIndex} 个问题当前是 "${question.status}"，不可提问`)
    }
    question.status = 'asked'
  }

  /**
   * 为一个已提出的问题给出下一级升级提示。返回提示文本；提示阶梯用尽时返回
   * `null` —— 此时必须公布答案，并要求学生用自己的话复述，再走 `assessAnswer`。
   */
  giveHint(state: LearningState, milestoneId: string, questionIndex: number): string | null {
    const question = this.question(state, milestoneId, questionIndex)
    if (question.status !== 'asked') {
      throw new LearningError('ILLEGAL_TRANSITION', `第 ${questionIndex} 个问题必须先提出才能给提示`)
    }
    if (question.hintLevel >= question.hints.length) return null
    const hint = question.hints[question.hintLevel]
    question.hintLevel += 1
    return hint ?? null
  }

  /** 用评分结论（可选评分备注）给一个已提出的问题定分。 */
  assessAnswer(
    state: LearningState,
    milestoneId: string,
    questionIndex: number,
    passed: boolean,
    note?: string,
  ): void {
    const question = this.question(state, milestoneId, questionIndex)
    if (question.status !== 'asked') {
      throw new LearningError('ILLEGAL_TRANSITION', `第 ${questionIndex} 个问题必须先提出才能评分`)
    }
    question.status = passed ? 'passed' : 'failed'
    if (note !== undefined) question.note = note
  }

  private question(state: LearningState, milestoneId: string, questionIndex: number): Question {
    const milestone = this.milestone(state, milestoneId)
    const question = milestone.questions[questionIndex]
    if (question === undefined) {
      throw new LearningError('QUESTION_UNKNOWN', `里程碑 "${milestoneId}" 没有第 ${questionIndex} 个问题`)
    }
    return question
  }

  // ── 验证 ─────────────────────────────────────────────────────────────

  /**
   * 记录一次实际执行的验证门，并把结论折进里程碑。
   *
   * - 退出码 0 且所有问题已 passed → `verified`，随后启动下一个 pending
   *   里程碑（或整个流程完成）；
   * - 退出码 0 但仍有未通过的问题 → 保持 in_progress（`pending-questions`）；
   * - 退出码非 0 → `failed`；用 `retryMilestone` 重新打开。
   */
  recordGate(
    state: LearningState,
    milestoneId: string,
    input: Omit<GateRecord, 'milestone' | 'at'>,
  ): GateOutcome {
    const milestone = this.milestone(state, milestoneId)
    if (milestone.status !== 'in_progress') {
      throw new LearningError('ILLEGAL_TRANSITION', `里程碑 "${milestoneId}" 当前是 "${milestone.status}"，不是 in_progress`)
    }
    const record: GateRecord = {
      milestone: milestoneId,
      command: [...input.command],
      exitCode: input.exitCode,
      stdout: truncate(input.stdout, this.resolved.maxCapturedOutput),
      stderr: truncate(input.stderr, this.resolved.maxCapturedOutput),
      durationMs: input.durationMs,
      at: Date.now(),
    }
    state.records.push(record)
    if (input.exitCode !== 0) {
      milestone.status = 'failed'
      return { kind: 'failed' }
    }
    const openQuestions = milestone.questions.filter((question) => question.status !== 'passed')
    if (openQuestions.length > 0) {
      return { kind: 'pending-questions' }
    }
    milestone.status = 'verified'
    const open = state.milestones.filter((entry) => entry.status === 'pending')
    if (open.length === 0) {
      state.phase = 'complete'
      return { kind: 'verified' }
    }
    open[0]!.status = 'in_progress'
    return { kind: 'verified' }
  }

  // ── 视图 ─────────────────────────────────────────────────────────────

  /** 只读快照，供状态视图、模型工具与注入使用。 */
  snapshot(state: LearningState): EngineStateSnapshot {
    const current = state.milestones.find((milestone) => milestone.status === 'in_progress')
    const next = state.milestones.find((milestone) => milestone.status === 'pending')
    let questionCount = 0
    let doneQuestionCount = 0
    for (const milestone of state.milestones) {
      questionCount += milestone.questions.length
      doneQuestionCount += milestone.questions.filter((question) => question.status === 'passed').length
    }
    return {
      state,
      phase: state.phase,
      current,
      next,
      gateCount: state.records.length,
      questionCount,
      doneQuestionCount,
    }
  }

  /** `/thesis-defense status` 用的人类可读状态文本。 */
  describe(state: LearningState): string {
    const view = this.snapshot(state)
    const verified = state.milestones.filter((milestone) => milestone.status === 'verified').length
    const lines = [
      `代码演练状态 — phase: ${view.phase}`,
      `  origin: ${state.origin.path} (${state.origin.language})`,
      `  level: ${state.scope.level}${state.scope.module === undefined ? '' : `, module: ${state.scope.module}`}`,
      `  milestones: ${verified}/${state.milestones.length} verified`,
      `  todos: ${state.todos.filter((todo) => todo.status === 'done').length}/${state.todos.length} done`,
      `  questions: ${view.doneQuestionCount}/${view.questionCount} passed`,
      `  gate runs: ${view.gateCount}`,
    ]
    if (view.current !== undefined) {
      const todos = view.current.todos
        .map((id) => state.todos.find((todo) => todo.id === id))
        .filter((todo) => todo !== undefined)
      const doneCount = todos.filter((todo) => todo.status === 'done').length
      lines.push(
        `  current: ${view.current.title} (todos ${doneCount}/${todos.length} done, questions ${view.current.questions.length})`,
      )
    } else if (view.next !== undefined) {
      lines.push(`  next: ${view.next.title}`)
    }
    return lines.join('\n')
  }
}

// ── 纯函数辅助 ───────────────────────────────────────────────────────────

function serializeState(state: LearningState): string {
  return `${JSON.stringify(state, null, 2)}\n`
}

function parseState(text: string): LearningState {
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch {
    throw new LearningError('STATE_INVALID', '状态文件不是合法 JSON')
  }
  const state = value as LearningState
  validateStateShape(state)
  return state
}

/** 对已加载（或即将保存）状态做结构校验。 */
function validateStateShape(value: unknown): asserts value is LearningState {
  if (typeof value !== 'object' || value === null) {
    throw new LearningError('STATE_INVALID', '状态必须是对象')
  }
  const state = value as Partial<LearningState>
  if (state.schemaVersion !== 1) {
    throw new LearningError('STATE_INVALID', `不支持的 schemaVersion ${String(state.schemaVersion)}`)
  }
  if (!PHASES.includes(state.phase as Phase)) {
    throw new LearningError('STATE_INVALID', `非法阶段 ${String(state.phase)}`)
  }
  if (
    typeof state.origin?.path !== 'string' ||
    typeof state.origin.language !== 'string' ||
    typeof state.scope?.level !== 'string'
  ) {
    throw new LearningError('STATE_INVALID', 'origin 或 scope 字段格式错误')
  }
  if (state.gates === undefined || typeof state.gates[state.origin.language] !== 'object') {
    throw new LearningError('STATE_INVALID', `语言 "${state.origin.language}" 没有记录验证门`)
  }
  if (!Array.isArray(state.milestones) || !Array.isArray(state.todos) || !Array.isArray(state.records)) {
    throw new LearningError('STATE_INVALID', 'milestones、todos 或 records 不是数组')
  }
  for (const milestone of state.milestones) {
    if (!MILESTONE_STATUS.includes(milestone.status)) {
      throw new LearningError('STATE_INVALID', `里程碑 "${milestone.id}" 的状态非法`)
    }
    for (const todoId of milestone.todos) {
      if (!state.todos.some((todo) => todo.id === todoId)) {
        throw new LearningError('STATE_INVALID', `里程碑 "${milestone.id}" 引用了未知 todo "${todoId}"`)
      }
    }
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string') return code
  }
  return undefined
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `\u2026${text.slice(-(max - 1))}`
}
