/**
 * 进度台账、时间线、决定日志的数据模型与读写逻辑。
 *
 * 设计要点（见 DESIGN.md §5）：
 * - 台账的机器真相是一个 JSON 状态块，藏在 Markdown 的 `<!-- thesis:state -->`
 *   HTML 注释里；表格等人类可读部分由 renderLedger 每次重绘，两者永不失步。
 * - 关卡闸门（G1/G2/G3/G4）在工具层强制执行，不是"靠 AI 自觉"：
 *   未通过某阶段的 gateIn，该阶段任务不允许进入 doing/done。
 *
 * 本模块只依赖 Node 内置能力，可在任何环境独立测试。
 */

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export type TaskStatus = 'todo' | 'doing' | 'done'

export interface Task {
  /** 稳定任务 ID，如 T1.1。 */
  readonly id: string
  readonly title: string
  readonly stage: number
  status: TaskStatus
  /** 关联的人工关卡（如 G1）；该任务 done 是关卡通过的前提之一。 */
  readonly gate?: string
  note?: string
}

export type GateStatus = 'pending' | 'passed'

export interface GateState {
  status: GateStatus
  /** 通过日期（ISO 日期字符串）。 */
  date?: string
  note?: string
  /** G2 专用：各章验收状态。 */
  chapters?: Record<string, GateStatus>
}

export interface ThesisState {
  title?: string
  currentStage: number
  updatedAt: string
  gates: Record<string, GateState>
  tasks: Task[]
}

export interface StageMeta {
  readonly id: number
  readonly name: string
  /** 进入该阶段前必须已通过的关卡。 */
  readonly gateIn?: string
  /** 离开该阶段前必须已通过的关卡。 */
  readonly gateOut?: string
}

export interface Milestone {
  readonly id: string
  readonly name: string
  readonly due?: string
  status: 'pending' | 'done'
  readonly dependsOn: readonly string[]
}

export interface TimelineState {
  milestones: Milestone[]
}

export interface DecisionEntry {
  readonly date: string
  readonly title: string
  readonly content: string
  readonly reason?: string
  readonly alternatives?: string
}

// ---------------------------------------------------------------------------
// 阶段与关卡注册表（与 skills/thesis-pipeline/SKILL.md 保持一致）
// ---------------------------------------------------------------------------

export const STAGES: readonly StageMeta[] = [
  { id: 1, name: '选题', gateOut: 'G1' },
  { id: 2, name: '开题', gateIn: 'G1', gateOut: 'G3' },
  { id: 3, name: '文献调研' },
  { id: 4, name: '系统设计' },
  { id: 5, name: '系统实现' },
  { id: 6, name: '系统测试' },
  { id: 7, name: '论文撰写' },
  { id: 8, name: '定稿与合规', gateIn: 'G2' },
  { id: 9, name: '答辩', gateIn: 'G4' },
]

export const GATE_NAMES: Readonly<Record<string, string>> = {
  G1: '选题拍板',
  G2: '逐章验收',
  G3: '开题报告审阅',
  G4: '提交前自查',
}

/** G2 覆盖的论文七章（与 layout.ts 的章节模板一致）。 */
export const CHAPTERS: readonly string[] = [
  '01-绪论',
  '02-相关技术',
  '03-需求分析',
  '04-系统设计',
  '05-系统实现',
  '06-系统测试',
  '07-总结与展望',
]

export function defaultTasks(): Task[] {
  return [
    { id: 'T1.1', title: '选题工作坊：明确课题方向', stage: 1, status: 'todo' },
    { id: 'T1.2', title: '选题确认书（G1）', stage: 1, status: 'todo', gate: 'G1' },
    { id: 'T2.1', title: '文献初检索（支撑选题与开题）', stage: 2, status: 'todo' },
    { id: 'T2.2', title: '开题报告起草', stage: 2, status: 'todo' },
    { id: 'T2.3', title: '开题报告审阅（G3）', stage: 2, status: 'todo', gate: 'G3' },
    { id: 'T3.1', title: '建立文献库 refs.bib', stage: 3, status: 'todo' },
    { id: 'T3.2', title: '逐篇文献笔记', stage: 3, status: 'todo' },
    { id: 'T3.3', title: '文献综述素材整理', stage: 3, status: 'todo' },
    { id: 'T4.1', title: '需求分析', stage: 4, status: 'todo' },
    { id: 'T4.2', title: '系统设计（架构/模块/接口）', stage: 4, status: 'todo' },
    { id: 'T4.3', title: '技术选型论证', stage: 4, status: 'todo' },
    { id: 'T5.1', title: '开发环境搭建', stage: 5, status: 'todo' },
    { id: 'T5.2', title: '核心功能实现（可运行优先）', stage: 5, status: 'todo' },
    { id: 'T5.3', title: '中期检查材料', stage: 5, status: 'todo' },
    { id: 'T6.1', title: '测试计划', stage: 6, status: 'todo' },
    { id: 'T6.2', title: '功能测试执行（真实结果留证）', stage: 6, status: 'todo' },
    { id: 'T6.3', title: '测试结果记录', stage: 6, status: 'todo' },
    { id: 'T7.1', title: '论文大纲', stage: 7, status: 'todo' },
    { id: 'T7.2', title: '逐章撰写与验收（G2×7）', stage: 7, status: 'todo', gate: 'G2' },
    { id: 'T7.3', title: '全文统稿', stage: 7, status: 'todo' },
    { id: 'T8.1', title: '格式检查', stage: 8, status: 'todo' },
    { id: 'T8.2', title: '引用检查', stage: 8, status: 'todo' },
    { id: 'T8.3', title: '自查报告（G4）', stage: 8, status: 'todo', gate: 'G4' },
    { id: 'T9.1', title: '答辩 PPT', stage: 9, status: 'todo' },
    { id: 'T9.2', title: '预答辩演练', stage: 9, status: 'todo' },
  ]
}

export function defaultState(now: Date = new Date()): ThesisState {
  const chapters: Record<string, GateStatus> = {}
  for (const c of CHAPTERS) chapters[c] = 'pending'
  return {
    currentStage: 1,
    updatedAt: now.toISOString(),
    gates: {
      G1: { status: 'pending' },
      G2: { status: 'pending', chapters },
      G3: { status: 'pending' },
      G4: { status: 'pending' },
    },
    tasks: defaultTasks(),
  }
}

export function stageMeta(id: number): StageMeta | undefined {
  return STAGES.find(s => s.id === id)
}

export function gatePassed(state: ThesisState, gate: string): boolean {
  const g = state.gates[gate]
  if (!g) return false
  if (gate !== 'G2') return g.status === 'passed'
  // G2 需七章全部通过。
  return g.status === 'passed' || (g.chapters !== undefined && CHAPTERS.every(c => g.chapters![c] === 'passed'))
}

// ---------------------------------------------------------------------------
// 状态块提取与序列化
// ---------------------------------------------------------------------------

const STATE_RE = /<!-- thesis:state\n([\s\S]*?)\n-->\s*/

export interface LedgerParse {
  readonly state: ThesisState
  readonly found: boolean
}

/** 从台账 Markdown 提取 JSON 状态块；缺失时返回 found:false 与默认状态。 */
export function parseLedger(md: string): LedgerParse {
  const m = STATE_RE.exec(md)
  if (!m || m[1] === undefined) return { state: defaultState(), found: false }
  try {
    return { state: JSON.parse(m[1]) as ThesisState, found: true }
  } catch {
    return { state: defaultState(), found: false }
  }
}

export function stateToJson(state: ThesisState): string {
  return JSON.stringify(state, null, 2)
}

// ---------------------------------------------------------------------------
// 关卡闸门
// ---------------------------------------------------------------------------

export interface GateCheck {
  readonly ok: boolean
  readonly reason: string
}

/**
 * 把任务推进到 toStatus 是否被允许。
 * 规则：任务所在阶段有 gateIn 时，该关卡必须已通过；关联 gate 的任务
 * 必须先完成（done）才能把该关卡标记通过（由 applyGate 检查）。
 */
export function canUpdateTask(state: ThesisState, task: Task, toStatus: TaskStatus): GateCheck {
  if (toStatus === 'todo') return { ok: true, reason: '' }
  const meta = stageMeta(task.stage)
  if (meta?.gateIn !== undefined && !gatePassed(state, meta.gateIn)) {
    return {
      ok: false,
      reason: `阶段 ${task.stage}（${meta.name}）的入口关卡 ${meta.gateIn}（${GATE_NAMES[meta.gateIn] ?? meta.gateIn}）尚未通过，禁止推进任务 ${task.id}。`,
    }
  }
  return { ok: true, reason: '' }
}

/**
 * 重算 currentStage：第一个"仍有待办任务且入口关卡已通过（或没有入口关卡）"的阶段。
 * 阶段出口关卡未通过时不会越过该阶段进入下一阶段。
 */
export function recomputeStage(state: ThesisState): void {
  let candidate = state.currentStage
  for (const meta of STAGES) {
    if (meta.gateIn !== undefined && !gatePassed(state, meta.gateIn)) continue
    const hasWork = state.tasks.some(t => t.stage === meta.id && t.status !== 'done')
    if (hasWork) {
      candidate = meta.id
      break
    }
  }
  state.currentStage = candidate
}

export function applyTaskUpdate(state: ThesisState, taskId: string, toStatus: TaskStatus, note?: string, now: Date = new Date()): GateCheck & { task?: Task } {
  const task = state.tasks.find(t => t.id === taskId)
  if (!task) return { ok: false, reason: `任务 ${taskId} 不存在。可用任务见进度台账。` }
  const check = canUpdateTask(state, task, toStatus)
  if (!check.ok) return check
  task.status = toStatus
  if (note !== undefined) task.note = note
  recomputeStage(state)
  state.updatedAt = now.toISOString()
  return { ok: true, reason: '', task }
}

export function applyGate(state: ThesisState, gate: string, pass: boolean, opts: { chapter?: string; note?: string; now?: Date } = {}): GateCheck {
  const g = state.gates[gate]
  if (!g) return { ok: false, reason: `关卡 ${gate} 不存在。有效关卡：${Object.keys(GATE_NAMES).join('、')}。` }
  const now = opts.now ?? new Date()
  if (gate === 'G2') {
    const chapter = opts.chapter
    if (chapter === undefined || !CHAPTERS.includes(chapter)) {
      return { ok: false, reason: `关卡 G2 需要指定 chapter，有效值：${CHAPTERS.join('、')}。` }
    }
    if (pass) {
      g.chapters = { ...(g.chapters ?? {}), [chapter]: 'passed' }
      if (CHAPTERS.every(c => (g.chapters ?? {})[c] === 'passed')) g.status = 'passed'
    } else {
      g.chapters = { ...(g.chapters ?? {}), [chapter]: 'pending' }
      g.status = 'pending'
    }
    g.date = now.toISOString()
    if (opts.note !== undefined) g.note = opts.note
  } else {
    // 非 G2 关卡：通过前必须确认其关联任务已完成。
    if (pass) {
      const owners = state.tasks.filter(t => t.gate === gate)
      const notDone = owners.filter(t => t.status !== 'done')
      if (notDone.length > 0) {
        return {
          ok: false,
          reason: `关卡 ${gate} 关联任务 ${notDone.map(t => t.id).join('、')} 尚未完成（done），请先完成对应产出再通过关卡。`,
        }
      }
    }
    g.status = pass ? 'passed' : 'pending'
    g.date = pass ? now.toISOString() : undefined
    if (opts.note !== undefined) g.note = opts.note
  }
  state.updatedAt = now.toISOString()
  recomputeStage(state)
  return { ok: true, reason: '' }
}

// ---------------------------------------------------------------------------
// 渲染：台账 Markdown 与状态报告
// ---------------------------------------------------------------------------

const STATUS_MARK: Record<TaskStatus, string> = { todo: '待办', doing: '进行中', done: '完成' }

export function renderLedger(state: ThesisState): string {
  const lines: string[] = []
  lines.push('# 进度台账')
  lines.push('')
  lines.push('> 本文件由 `thesis_progress` 工具维护：`<!-- thesis:state -->` 内是机器真相（JSON），')
  lines.push('> 下方表格由工具重绘。请勿手工修改 JSON 块；如确需手工编辑，请保持 JSON 合法。')
  lines.push('')
  lines.push('<!-- thesis:state')
  lines.push(stateToJson(state))
  lines.push('-->')
  lines.push('')
  const meta = stageMeta(state.currentStage)
  lines.push('## 当前状态')
  lines.push('')
  lines.push(`- 阶段：${meta ? `${meta.id} · ${meta.name}` : `未知（${state.currentStage}）`}`)
  if (state.title) lines.push(`- 课题：${state.title}`)
  lines.push(`- 最近更新：${state.updatedAt}`)
  lines.push('')
  lines.push('## 人工关卡')
  lines.push('')
  lines.push('| 关卡 | 名称 | 状态 | 说明 |')
  lines.push('|---|---|---|---|')
  for (const [id, name] of Object.entries(GATE_NAMES)) {
    const g = state.gates[id]
    const passed = gatePassed(state, id)
    const detail = id === 'G2' && g?.chapters !== undefined
      ? `已过 ${CHAPTERS.filter(c => g.chapters![c] === 'passed').length}/${CHAPTERS.length} 章`
      : (g?.note ?? '')
    lines.push(`| ${id} | ${name} | ${passed ? '✅ 已通过' : '⬜ 未通过'} | ${detail} |`)
  }
  lines.push('')
  for (const s of STAGES) {
    const tasks = state.tasks.filter(t => t.stage === s.id)
    if (tasks.length === 0) continue
    lines.push(`## 阶段 ${s.id} · ${s.name}`)
    lines.push('')
    lines.push('| ID | 任务 | 状态 | 备注 |')
    lines.push('|---|---|---|---|')
    for (const t of tasks) {
      lines.push(`| ${t.id} | ${t.title}${t.gate ? `（${t.gate}）` : ''} | ${STATUS_MARK[t.status]} | ${t.note ?? ''} |`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

export function renderReport(state: ThesisState): string {
  const meta = stageMeta(state.currentStage)
  const parts: string[] = []
  parts.push(`当前阶段：${meta ? `${meta.id} · ${meta.name}` : `未知（${state.currentStage}）`}${state.title ? `；课题：${state.title}` : ''}`)
  const gates = Object.entries(GATE_NAMES).map(([id, name]) => {
    const passed = gatePassed(state, id)
    const g = state.gates[id]
    const detail = id === 'G2' && g?.chapters !== undefined
      ? `（${CHAPTERS.filter(c => g.chapters![c] === 'passed').length}/${CHAPTERS.length} 章）`
      : ''
    return `${id} ${name}: ${passed ? '已通过' : '未通过'}${detail}`
  })
  parts.push('关卡：' + gates.join('；'))
  const stageTasks = state.tasks.filter(t => t.stage === state.currentStage)
  parts.push(`本阶段任务：${stageTasks.map(t => `${t.id} ${t.title} [${STATUS_MARK[t.status]}]`).join('；') || '（无）'}`)
  const next = state.tasks.find(t => t.status === 'todo')
  parts.push(next ? `下一个待办：${next.id} ${next.title}` : '全部任务已完成，进入答辩前复核。')
  return parts.join('\n')
}

// ---------------------------------------------------------------------------
// 时间线
// ---------------------------------------------------------------------------

const TIMELINE_RE = /<!-- thesis:timeline\n([\s\S]*?)\n-->\s*/

export function defaultTimeline(): TimelineState {
  return {
    milestones: [
      { id: 'M1', name: '选题确定', status: 'pending', dependsOn: [] },
      { id: 'M2', name: '开题报告提交', status: 'pending', dependsOn: ['M1'] },
      { id: 'M3', name: '系统设计完成', status: 'pending', dependsOn: ['M2'] },
      { id: 'M4', name: '核心功能实现', status: 'pending', dependsOn: ['M3'] },
      { id: 'M5', name: '论文初稿', status: 'pending', dependsOn: ['M4'] },
      { id: 'M6', name: '定稿与自查', status: 'pending', dependsOn: ['M5'] },
      { id: 'M7', name: '答辩', status: 'pending', dependsOn: ['M6'] },
    ],
  }
}

export function parseTimeline(md: string): { state: TimelineState; found: boolean } {
  const m = TIMELINE_RE.exec(md)
  if (!m || m[1] === undefined) return { state: defaultTimeline(), found: false }
  try {
    return { state: JSON.parse(m[1]) as TimelineState, found: true }
  } catch {
    return { state: defaultTimeline(), found: false }
  }
}

export function renderTimeline(t: TimelineState): string {
  const lines: string[] = []
  lines.push('# 时间线')
  lines.push('')
  lines.push('> 里程碑与截止日期。`due` 使用 ISO 日期（YYYY-MM-DD）。')
  lines.push('> 由 thesis-pipeline 技能指导维护；`<!-- thesis:timeline -->` 内是机器真相。')
  lines.push('')
  lines.push('<!-- thesis:timeline')
  lines.push(JSON.stringify(t, null, 2))
  lines.push('-->')
  lines.push('')
  lines.push('| 里程碑 | 截止 | 状态 | 依赖 |')
  lines.push('|---|---|---|---|')
  for (const m of t.milestones) {
    lines.push(`| ${m.id} ${m.name} | ${m.due ?? '—'} | ${m.status === 'done' ? '✅' : '⬜'} | ${m.dependsOn.join('、') || '—'} |`)
  }
  lines.push('')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// 决定日志
// ---------------------------------------------------------------------------

export function renderDecisionEntry(entry: DecisionEntry): string {
  const lines: string[] = []
  lines.push(`## ${entry.date} · ${entry.title}`)
  lines.push('')
  lines.push(`- 决定：${entry.content}`)
  if (entry.reason) lines.push(`- 理由：${entry.reason}`)
  if (entry.alternatives) lines.push(`- 备选：${entry.alternatives}`)
  lines.push('')
  return lines.join('\n')
}

export function appendDecision(md: string, entry: DecisionEntry): string {
  const base = md.trimEnd()
  return base.length > 0 ? `${base}\n\n${renderDecisionEntry(entry)}` : `# 决定日志\n\n> 每个关键决定的留痕：内容、理由、备选。答辩时它是"我为什么这么写"的证据。\n\n${renderDecisionEntry(entry)}`
}

export function countDecisions(md: string): number {
  const matches = md.match(/^## \d{4}-\d{2}-\d{2} · /gm)
  return matches === null ? 0 : matches.length
}
