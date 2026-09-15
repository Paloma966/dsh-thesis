/**
 * 演练状态 schema：持久化在 `<cwd>/.paper/state.json`。
 *
 * 一个文件随演练骨架仓库一起走，因此进度能跨过每一次会话边界：里程碑、todo
 * 状态、已提出的问题、评分备注、验证门记录全都落在这里，而不是留在对话记忆里。
 *
 * @module dsh-thesis/codewalk
 */

/** 难度：1（读数据模型）到 4（分布式协同）。 */
export type Difficulty = 1 | 2 | 3 | 4

/** 一个带注释的骨架桩：这段代码做什么（WHAT）以及怎么重建（HOW）。 */
export interface Todo {
  /** 供里程碑引用的稳定 id，如 "t3"。 */
  readonly id: string
  /** 文件与符号位置，如 "internal/store/task.go SaveTask"。 */
  readonly where: string
  /** 一句话说明这个方法的目的。 */
  readonly what: string
  /** 分步实现提示。 */
  readonly steps: readonly string[]
  /** 可选的坑、设计理由与语言/库特性。 */
  readonly hint?: string
  /** 难度评级。 */
  readonly difficulty: Difficulty
  status: TodoStatus
}

export type TodoStatus = 'pending' | 'in_progress' | 'done'

/** 一个验证门：一条必须成功的可执行命令行。 */
export interface GateSpec {
  /** 命令与参数，如 ["go", "build", "./..."]。 */
  build: string[]
}

/** 一次实际执行的验证门：里程碑确实被验证过的证据。 */
export interface GateRecord {
  /** 该验证门所属的里程碑 id。 */
  readonly milestone: string
  /** 实际执行的命令行。 */
  readonly command: readonly string[]
  /** 进程退出码。 */
  readonly exitCode: number
  /** 捕获的 stdout，受 `maxCapturedOutput` 截断。 */
  readonly stdout: string
  /** 捕获的 stderr，受 `maxCapturedOutput` 截断。 */
  readonly stderr: string
  /** 墙钟耗时（毫秒）。 */
  readonly durationMs: number
  /** 执行时刻（epoch 毫秒）。 */
  readonly at: number
}

/** 一个追问：含评分标准与升级提示。 */
export interface Question {
  /** AI 应该向学生提出的问题。 */
  readonly ask: string
  /**
   * 作为评分标准的期望答案要点。AI 用它与学生的回答比对，而不是凭感觉打分。
   * 绝不直接展示给学生；只能通过提示阶梯逐步接近。
   */
  readonly expected: readonly string[]
  /** 逐步升级的提示，在公布答案之前一次给一条。 */
  readonly hints: readonly string[]
  status: QuestionStatus
  /** 已经给过多少条提示（0..hints.length）。 */
  hintLevel: number
  /** 评分定分时记录的备注。 */
  note?: string
}

export type QuestionStatus = 'unasked' | 'asked' | 'passed' | 'failed'

/** 一组相关 todo 加上它的验证门与问题：一个演练步骤。 */
export interface Milestone {
  /** 稳定 id，如 "m1"。 */
  readonly id: string
  /** 简短的人类标题，如 "etcd 里的任务 CRUD"。 */
  readonly title: string
  /** 本里程碑覆盖的 todo id。 */
  readonly todos: readonly string[]
  /** 里程碑级验证门；缺省时回退到语言级验证门。 */
  readonly gate?: GateSpec
  /** 本里程碑的追问。 */
  readonly questions: readonly Question[]
  status: MilestoneStatus
}

export type MilestoneStatus = 'pending' | 'in_progress' | 'verified' | 'failed'

/** 工作流阶段；严格单向前进。 */
export type Phase = 'analyzing' | 'skeletonizing' | 'learning' | 'complete'

/** `create` 时选定的学生水平。 */
export type LearnerLevel = 'beginner' | 'intermediate' | 'advanced'

/** 整个持久化演练状态。 */
export interface LearningState {
  readonly schemaVersion: 1
  phase: Phase
  /** 原始项目在哪里、用什么语言。 */
  readonly origin: {
    /** 学生要研究的原始项目绝对路径。 */
    readonly path: string
    /** 选择验证门的语言键，如 "go"。 */
    readonly language: string
  }
  /** create 时捕获的范围配置。 */
  readonly scope: {
    /** 可选：只聚焦某个子模块，而不是整个项目。 */
    readonly module?: string
    /** 学生水平校准。 */
    readonly level: LearnerLevel
  }
  /** 按演练顺序排列的里程碑。 */
  milestones: Milestone[]
  /** 全部 todo，隐式按 id 索引。 */
  todos: Todo[]
  /** create 时快照下来的语言验证门。 */
  readonly gates: Readonly<Record<string, GateSpec>>
  /** 每一次执行的验证门，最新的在最后。 */
  records: GateRecord[]
  /** 最后一次保存的 epoch 毫秒。 */
  updatedAt: number
}

/** `AiLearningEngine.create` 的新状态输入。 */
export interface CreateStateInput {
  readonly origin: LearningState['origin']
  readonly scope: LearningState['scope']
}

/**
 * 代码演练的部署配置（与 `src/config.ts` 的 `CodeWalkthroughOptions` 结构一致）。
 *
 * `src/config.ts` 的 `LearnOptions` 要求字段必填，可直接传给引擎；此处的可选
 * 版本便于单测里只覆盖关心的字段，缺省值由引擎统一回退。
 */
export interface LearnOptions {
  /** 会话 cwd 下存放状态文件的目录。 */
  stateDir?: string
  /** 按语言名索引的验证门，如 "go"。 */
  gates?: Record<string, GateSpec>
  /** 每条验证门输出流保留的最大字符数。 */
  maxCapturedOutput?: number
}

/** `AiLearningEngine.recordGate` 的结论。 */
export type GateOutcome =
  | { readonly kind: 'verified' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'pending-questions' }

export interface EngineStateSnapshot {
  readonly state: LearningState
  readonly phase: Phase
  readonly current: Milestone | undefined
  readonly next: Milestone | undefined
  readonly gateCount: number
  readonly questionCount: number
  readonly doneQuestionCount: number
}
