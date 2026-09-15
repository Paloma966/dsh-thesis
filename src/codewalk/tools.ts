/**
 * 面向前模型的工具：`defense_code_status`、`defense_code_next`、`defense_code_update`。
 *
 * 这三个工具是模型操作引擎的手柄：分析架构、安排教学由模型完成，但每一次改动
 * 都必须穿过引擎校验过的状态迁移，并立刻落盘。工具注册走 `ctx.tools`（只有在
 * 组合了工具注册表时才注册）；定义是纯对象，因此不需要任何 `@deepseek-ai/dsh-*`
 * 的运行时导入。
 *
 * @module dsh-thesis/codewalk
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { AiLearningEngine } from './engine.ts'
import { isLearningError } from './errors.ts'
import { runMilestoneGate } from './gate.ts'
import type { TextBlockShape, ToolDefinitionShape, ToolRunContextShape, ToolsServiceShape } from './host-types.ts'
import type { LearningState, Milestone, Phase, Question, Todo } from './types.ts'

const TODO_STATUS = ['pending', 'in_progress', 'done'] as const
const MILESTONE_STATUS = ['pending', 'in_progress', 'verified', 'failed'] as const
const QUESTION_STATUS = ['unasked', 'asked', 'passed', 'failed'] as const
const PHASES = ['analyzing', 'skeletonizing', 'learning', 'complete'] as const
const LEVELS = ['beginner', 'intermediate', 'advanced'] as const

const TODO_SCHEMA = {
  type: 'object',
  required: ['id', 'where', 'what', 'steps', 'difficulty', 'status'],
  properties: {
    id: { type: 'string', description: '稳定 id，供里程碑引用，如 "t3"。' },
    where: { type: 'string', description: '文件与符号位置，如 "internal/store/task.go SaveTask"。' },
    what: { type: 'string', description: '一句话说明这个方法的目的。' },
    steps: { type: 'array', items: { type: 'string' }, description: '分步实现提示。' },
    hint: { type: 'string', description: '可选的坑、设计理由与语言特性。' },
    difficulty: { type: 'integer', enum: [1, 2, 3, 4], description: '1（读数据模型）到 4（分布式协同）。' },
    status: { type: 'string', enum: [...TODO_STATUS] },
  },
  additionalProperties: false,
} as const

const QUESTION_SCHEMA = {
  type: 'object',
  required: ['ask', 'expected', 'hints', 'status', 'hintLevel'],
  properties: {
    ask: { type: 'string', description: '要向学生提出的追问。' },
    expected: {
      type: 'array',
      items: { type: 'string' },
      description: '作为评分标准的期望答案要点。绝不逐字公布给学生。',
    },
    hints: { type: 'array', items: { type: 'string' }, description: '逐步升级的提示，在公布答案之前一次给一条。' },
    status: { type: 'string', enum: [...QUESTION_STATUS] },
    hintLevel: { type: 'integer', description: '已经给过多少条提示。' },
    note: { type: 'string', description: '评分定分时记录的备注（可选）。' },
  },
  additionalProperties: false,
} as const

const MILESTONE_SCHEMA = {
  type: 'object',
  required: ['id', 'title', 'todos', 'questions'],
  properties: {
    id: { type: 'string', description: '稳定 id，如 "m1"。' },
    title: { type: 'string', description: '简短的人类标题，如 "etcd 里的任务 CRUD"。' },
    todos: { type: 'array', items: { type: 'string' }, description: '本里程碑覆盖的 todo id。' },
    gate: {
      type: 'object',
      required: ['build'],
      properties: {
        build: { type: 'array', items: { type: 'string' }, description: '命令与参数；缺省用语言级验证门。' },
      },
      additionalProperties: false,
    },
    questions: { type: 'array', items: QUESTION_SCHEMA },
  },
  additionalProperties: false,
} as const

/** 组合了工具注册表时，注册这三个面向前模型的工具。 */
export function registerTools(ctx: Context, engine: AiLearningEngine): void {
  const tools = ctx.get('tools') as ToolsServiceShape | undefined
  if (tools === undefined) return
  tools.register(statusTool(engine))
  tools.register(nextTool(engine))
  tools.register(updateTool(ctx, engine))
}

/** 解析一次工具调用的会话 cwd；缺失或没有演练状态时直接拒绝。 */
async function toolCwd(engine: AiLearningEngine, exec: ToolRunContextShape): Promise<LearningState> {
  const cwd = exec.agent?.session.header.cwd
  if (cwd === undefined) {
    throw new Error('learn_* 工具需要会话 cwd，但本次调用没有绑定 agent')
  }
  const state = await engine.load(cwd)
  if (state === undefined) {
    throw new Error(`${cwd} 下没有代码演练状态；请先执行 "/thesis-defense new <原始项目路径>"`)
  }
  return state
}

function text(text: string): TextBlockShape[] {
  return [{ type: 'text', text }]
}

function statusTool(engine: AiLearningEngine): ToolDefinitionShape {
  return {
    name: 'defense_code_status',
    description:
      '读取本会话 cwd 下代码演练的状态：阶段、里程碑、todo 进度、未完成的追问、编译验证门记录。' +
      '动手推进演练之前先用它看清当前位置。答辩前把系统讲清楚就从这里开始。',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => text(String(value)) },
    async execute(_args, exec) {
      const state = await toolCwd(engine, exec)
      return engine.describe(state)
    },
  }
}

function nextTool(engine: AiLearningEngine): ToolDefinitionShape {
  return {
    name: 'defense_code_next',
    description:
      '返回本会话 cwd 下一次该做什么：当前里程碑连同它的 todo、编译验证门与追问' +
      '（含用于评分的期望答案要点）。',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    output: { schema: { type: 'object' }, render: (_args, value) => text(JSON.stringify(value, null, 2)) },
    async execute(_args, exec) {
      const state = await toolCwd(engine, exec)
      return nextPayload(state)
    },
  }
}

function nextPayload(state: LearningState): Record<string, unknown> {
  const current = state.milestones.find((milestone) => milestone.status === 'in_progress')
  const gate = current === undefined ? undefined : (current.gate ?? state.gates[state.origin.language])
  return {
    phase: state.phase,
    current:
      current === undefined
        ? null
        : {
          id: current.id,
          title: current.title,
          status: current.status,
          gate,
          todos: current.todos
            .map((id) => state.todos.find((todo) => todo.id === id))
            .filter((todo) => todo !== undefined),
          questions: current.questions,
        },
    nextMilestone: state.milestones.find((milestone) => milestone.status === 'pending')?.id ?? null,
    guidance:
      state.phase === 'analyzing'
        ? '先分析原始项目，用 defense_code_update 把架构记成 todo 与里程碑，然后推进阶段。'
        : state.phase === 'skeletonizing'
          ? '开始搭骨架：剥掉非核心功能，留下带注释的 TODO 桩，用 /thesis-defense check 跑通编译验证门。'
          : state.phase === 'learning'
            ? '推进当前里程碑：带学生走完它的 todo，逐个提出追问，并对照期望要点评分。'
            : '全部里程碑已验证：总结学生现在能讲清哪些设计。',
  }
}

function updateTool(ctx: Context, engine: AiLearningEngine): ToolDefinitionShape {
  return {
    name: 'defense_code_update',
    description:
      '对本会话 cwd 的代码演练状态施加一次「经校验的」改动：登记 todo 与里程碑、迁移 todo 状态、推进阶段、' +
      '驱动追问与评分、重试里程碑。每一次改动都会立即落盘。',
    parameters: {
      type: 'object',
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: [
            'create',
            'upsert_todo',
            'upsert_milestone',
            'set_todo_status',
            'advance_phase',
            'ask_question',
            'give_hint',
            'assess_answer',
            'retry_milestone',
            'check_gate',
          ],
        },
        originPath: { type: 'string', description: '原始项目的绝对路径，action=create 时必填。' },
        language: { type: 'string', description: 'action=create 时的语言键，如 "go"。' },
        level: { type: 'string', enum: ['beginner', 'intermediate', 'advanced'], description: 'action=create 时的学生水平。' },
        module: { type: 'string', description: 'action=create 时可选：只聚焦某个子模块。' },
        todo: TODO_SCHEMA,
        milestone: MILESTONE_SCHEMA,
        todoId: { type: 'string' },
        status: { type: 'string', enum: [...TODO_STATUS] },
        phase: { type: 'string', enum: [...PHASES] },
        milestoneId: { type: 'string' },
        questionIndex: { type: 'integer' },
        passed: { type: 'boolean' },
        note: { type: 'string', description: 'assess_answer 的评分备注。' },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(String(value)) },
    async execute(args, exec) {
      const cwd = exec.agent?.session.header.cwd
      if (cwd === undefined) {
        throw new Error('learn_* 工具需要会话 cwd，但本次调用没有绑定 agent')
      }
      const update = args as UpdateArgs
      if (update.action === 'create') {
        const state = await engine.create(cwd, {
          origin: {
            path: requireFieldValue(update, 'originPath', 'create'),
            language: update.language ?? 'go',
          },
          scope: {
            level: update.level ?? 'beginner',
            ...(update.module !== undefined ? { module: update.module } : {}),
          },
        })
        return `已为 ${state.origin.path} 创建代码演练（${state.origin.language}，${state.scope.level}）。\n${engine.describe(state)}`
      }
      const state = await toolCwd(engine, exec)
      if (update.action === 'check_gate') {
        return await checkGate(ctx, engine, exec, cwd, state, update)
      }
      const result = applyUpdate(engine, state, update)
      await engine.save(cwd, state)
      return result
    },
    timeoutMs: 60_000,
  }
}

/** 从模型侧跑一次里程碑验证门，并渲染结论。 */
async function checkGate(
  ctx: Context,
  engine: AiLearningEngine,
  exec: ToolRunContextShape,
  cwd: string,
  state: LearningState,
  args: UpdateArgs,
): Promise<string> {
  const milestone = pickCheckMilestone(state.milestones, args.milestoneId)
  if (milestone === undefined) {
    throw new Error(
      args.milestoneId === undefined
        ? '当前没有 in_progress 或 failed 的里程碑，没有可检查的对象'
        : `未知里程碑 "${args.milestoneId}"`,
    )
  }
  const settled = await runMilestoneGate(ctx, engine, cwd, state, milestone, exec.signal, exec.agent?.session)
  const label = `验证门 "${settled.command.join(' ')}"`
  if (settled.interrupted) return `${label} 被中断；该里程碑已标记为 failed`
  if (settled.outcome.kind === 'failed') {
    return `${label} 失败（退出码 ${settled.exitCode}）；该里程碑已标记为 failed。\nstderr 末尾：\n${settled.stderr}`
  }
  if (settled.outcome.kind === 'pending-questions') {
    return `${label} 通过，但仍有 ${milestone.questions.filter((question) => question.status !== 'passed').length} 个问题未通过：先提问并评分，再重跑 check_gate。`
  }
  return `${label} 通过 —— 里程碑 "${milestone.id}" 已验证。${state.phase === 'complete' ? ' 全部里程碑已验证：本次代码演练完成。' : ''}`
}

function pickCheckMilestone(milestones: readonly Milestone[], requestedId: string | undefined): Milestone | undefined {
  if (requestedId !== undefined) return milestones.find((milestone) => milestone.id === requestedId)
  return (
    milestones.find((milestone) => milestone.status === 'in_progress') ??
    milestones.find((milestone) => milestone.status === 'failed')
  )
}

interface UpdateArgs {
  readonly action: string
  readonly originPath?: string
  readonly language?: string
  readonly level?: (typeof LEVELS)[number]
  readonly module?: string
  readonly todo?: Todo
  readonly milestone?: Milestone
  readonly todoId?: string
  readonly status?: (typeof TODO_STATUS)[number]
  readonly phase?: Phase
  readonly milestoneId?: string
  readonly questionIndex?: number
  readonly passed?: boolean
  readonly note?: string
}

function applyUpdate(engine: AiLearningEngine, state: LearningState, args: UpdateArgs): string {
  switch (args.action) {
    case 'upsert_todo': {
      if (args.todo === undefined) throw new Error('upsert_todo 需要 "todo"')
      engine.upsertTodo(state, args.todo)
      return `已登记 todo ${args.todo.id}（${args.todo.where}）`
    }
    case 'upsert_milestone': {
      if (args.milestone === undefined) throw new Error('upsert_milestone 需要 "milestone"')
      engine.upsertMilestone(state, args.milestone)
      return `已登记里程碑 ${args.milestone.id}（${args.milestone.title}）：${args.milestone.todos.length} 个 todo、${args.milestone.questions.length} 个问题`
    }
    case 'set_todo_status': {
      requireField(args, 'todoId', 'set_todo_status')
      requireField(args, 'status', 'set_todo_status')
      engine.setTodoStatus(state, args.todoId!, args.status!)
      return `todo ${args.todoId} → ${args.status}`
    }
    case 'advance_phase': {
      requireField(args, 'phase', 'advance_phase')
      engine.advancePhase(state, args.phase!)
      return `阶段 → ${state.phase}${state.phase === 'learning' ? `；当前里程碑：${state.milestones.find((milestone) => milestone.status === 'in_progress')?.id ?? '无'}` : ''}`
    }
    case 'ask_question': {
      requireField(args, 'milestoneId', 'ask_question')
      requireField(args, 'questionIndex', 'ask_question')
      engine.askQuestion(state, args.milestoneId!, args.questionIndex!)
      return `问题 ${args.milestoneId}[${args.questionIndex}] 已标记为已提出`
    }
    case 'give_hint': {
      requireField(args, 'milestoneId', 'give_hint')
      requireField(args, 'questionIndex', 'give_hint')
      const hint = engine.giveHint(state, args.milestoneId!, args.questionIndex!)
      return hint === null
        ? `${args.milestoneId}[${args.questionIndex}] 的提示阶梯已用尽；公布答案并让学生复述，然后再评分`
        : `提示 ${args.milestoneId}[${args.questionIndex}]：${hint}`
    }
    case 'assess_answer': {
      requireField(args, 'milestoneId', 'assess_answer')
      requireField(args, 'questionIndex', 'assess_answer')
      requireField(args, 'passed', 'assess_answer')
      engine.assessAnswer(state, args.milestoneId!, args.questionIndex!, args.passed!, args.note)
      return `问题 ${args.milestoneId}[${args.questionIndex}] 评分：${args.passed ? '通过' : '未通过'}`
    }
    case 'retry_milestone': {
      requireField(args, 'milestoneId', 'retry_milestone')
      engine.retryMilestone(state, args.milestoneId!)
      return `里程碑 ${args.milestoneId} 已重新打开，可以再试一次`
    }
    default:
      throw new Error(`未知的更新动作 "${args.action}"`)
  }
}

function requireField(args: UpdateArgs, key: keyof UpdateArgs, action: string): void {
  if (args[key] === undefined) throw new Error(`${action} 需要 "${key}"`)
}

/** 取一个必填字符串字段（收窄类型），否则抛错。 */
function requireFieldValue(args: UpdateArgs, key: 'originPath' | 'language' | 'module' | 'milestoneId' | 'todoId', action: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value === '') throw new Error(`${action} 需要 "${key}"`)
  return value
}

/** pre-step 注入用的随机 id 生成器；导出以便复用。 */
export function newMessageId(): string {
  return randomUUID()
}

export { isLearningError }
