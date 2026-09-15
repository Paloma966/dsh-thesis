/**
 * 材料到手后的逐题追问：问题库、排序裁剪、材料感知。
 *
 * 设计要点（与 `gates/detect.ts` 同一套「便宜、面向人、有终止条件」）：
 * 1. **一次只问一个**：本模块只回答「下一个该问什么」，绝不在一次返回里塞多个问题；
 * 2. **可证伪**：每个问题都写清 `why`（不答会返什么工）、`affects`（影响哪个产出物）、
 *    `answerShape`（什么样的答案算合格），使回答能被机器写进意图规格并被后续阶段校验；
 * 3. **材料感知**：`thesis_ingest` 已经把材料读进工作区，凡是材料里已经有的答案就
 *    **不再重复问**——能自动回答的标为「待用户确认」，能安全推断的直接免问。
 *    这是「一次到位」的关键：问用户之前先问工作区。
 *
 * 本文件是纯函数模块：零 I/O、零宿主依赖，输入 `IntakeState` + {@link IntakeContext}，
 * 输出结构化的下一个问题。所有排序都是全序（priority → 问题库顺序），结果确定。
 *
 * @module dsh-thesis/intake
 */

import type { IntakeState } from './state.ts'

/**
 * 追问影响的产出物（`affects` 的取值范围）。
 *
 * **可达性契约**：每个取值都必须被至少一个真实工具兑现（见 {@link AFFECT_TOOLS}）。
 * 这条约束由 `tests/intake-questions.test.ts` 断言：新增问题若声称影响一个
 * 没有工具兑现的产出物，测试立刻变红——这样「问了一堆用不上的要求」无法退化。
 */
export type IntakeAffect =
  | '格式检查'
  | '引用规范'
  | '字数分配'
  | '写作规范'
  | '原创性'
  | '答案PPT'
  | '答辩问答'
  | '文献检索'

/** 每个产出物由哪些工具兑现（工具名是契约，见 DESIGN.md §5）。 */
export const AFFECT_TOOLS: Readonly<Record<IntakeAffect, readonly string[]>> = {
  格式检查: ['thesis_check'],
  引用规范: ['thesis_lit_search', 'thesis_lit_save', 'thesis_lit_note', 'thesis_check'],
  字数分配: ['thesis_review', 'thesis_check'],
  写作规范: ['thesis_stylecheck'],
  原创性: ['thesis_originality'],
  答案PPT: ['thesis_slides'],
  答辩问答: ['thesis_defense', 'defense_code_status', 'defense_code_next', 'defense_code_update'],
  文献检索: ['thesis_lit_search'],
}

/** 轻校验结果：`ok:false` + `note` 表示「记录但标注问题」，不阻断对话。 */
export interface AnswerCheck {
  ok: boolean
  note?: string
}

/** 轻校验函数：写成显式签名，避免对象字面量里的参数被推断为 any。 */
export type AnswerValidator = (answer: string) => AnswerCheck

/** 结构化问题：写给用户的一句话 + 为什么问 + 合格答案形态。 */
export interface IntakeQuestion {
  /** 稳定 id，如 'school.name'（写进状态与规格，改动即破坏断点续问）。 */
  id: string
  /** 规格里的分节，如 '学校与规范'。 */
  section: string
  /** 问给用户的一句话（口语、便宜、一次一问）。 */
  ask: string
  /** 为什么问：不答会导致什么返工（必须是具体的返工，不是"信息不完整"）。 */
  why: string
  /** 影响的产出物。 */
  affects: IntakeAffect[]
  /** 合格答案的形态（含示例），用户照着答即可。 */
  answerShape: string
  /** 不答就无法进入下一阶段（`done` 会拒绝）。 */
  required: boolean
  /** 用户答不上来时的提示：去哪找（教务处/学长/导师/学校文件）。 */
  hint?: string
  /** 轻校验：格式不对只给 note，绝不替用户改写答案。 */
  validate?: AnswerValidator
  /** 排序权重，1 最高（同优先级下小者先问）。 */
  priority: number
}

/** 材料清单里的一个条目（`00-管理/材料清单.md` 的一行）。 */
export interface MaterialEntry {
  /** 材料在论文工作区里的相对路径（或文件名）。 */
  readonly path: string
  /** 清单声明的类型，如 `学校模板`、`实验数据`；缺省为空串。 */
  readonly kind: string
  /** 低置信度的粗分类，用于兜底匹配（docx/xlsx/csv/md/pdf…）。 */
  readonly ext: string
}

/** 工作区材料摘要：`thesis_ingest` 的产物经宽容解析后的结果。 */
export interface MaterialSummary {
  /** 清单文件是否存在（缺失时 items 为空，一切照常提问）。 */
  readonly found: boolean
  readonly items: readonly MaterialEntry[]
}

/** 追问上下文：材料摘要 + 当前阶段（由台账推断）。 */
export interface IntakeContext {
  readonly materials: MaterialSummary
  /** 台账里的阶段名，如 `开题`；读不到台账时用 {@link DEFAULT_STAGE}。 */
  readonly stage: string
}

/** 读不到台账时的默认阶段（任务约定：按「开题前」处理）。 */
export const DEFAULT_STAGE = '开题前'

/** 空材料摘要：没有清单时的默认值。 */
export const EMPTY_MATERIALS: MaterialSummary = { found: false, items: [] }

/** 全部规格分节（渲染顺序即此顺序，保证幂等）。 */
export const INTAKE_SECTIONS: readonly string[] = [
  '学校与规范',
  '课题与目标',
  '时间线',
  '系统与数据',
  '文献与引用',
  '交付形式',
]

/** 阶段 → 优先命中的产出物；用于把「当前阶段最要紧的问题」排前面。 */
export const STAGE_AFFECTS: Readonly<Record<string, readonly IntakeAffect[]>> = {
  选题: ['字数分配', '答辩问答'],
  开题: ['引用规范', '字数分配'],
  文献调研: ['引用规范'],
  系统设计: ['答辩问答'],
  系统实现: ['答辩问答'],
  系统测试: ['答辩问答'],
  论文撰写: ['字数分配', '原创性', '格式检查'],
  定稿与合规: ['格式检查', '原创性', '引用规范'],
  答辩: ['答案PPT', '答辩问答'],
}

/** 按当前阶段给 `affects` 加权重（分数越小越先问）。 */
function affectRank(question: IntakeQuestion, stage: string): number {
  const wanted = STAGE_AFFECTS[stage]
  if (wanted === undefined) return 0
  for (const affect of question.affects) {
    if (wanted.includes(affect)) return 0
  }
  return 1
}

// ---------------------------------------------------------------------------
// 轻校验工具（全部可证伪：错就给一句具体的话，不阻止用户）
// ---------------------------------------------------------------------------

function text(answer: string, min = 2): AnswerCheck {
  const trimmed = answer.trim()
  if (trimmed.length === 0) return { ok: false, note: '答案为空。' }
  if (trimmed.length < min) return { ok: false, note: `「${trimmed}」太短，请写完整名称。` }
  return { ok: true }
}

/** 从答案里取第一个整数（"3 万字" → 3；"12000" → 12000）。 */
export function firstNumber(answer: string): number | undefined {
  const m = /\d+(?:\.\d+)?/.exec(answer.replace(/,/g, ''))
  if (m === null) return undefined
  const n = Number(m[0])
  return Number.isFinite(n) ? n : undefined
}

function positiveNumber(answer: string, min: number, max: number, what: string): AnswerCheck {
  const n = firstNumber(answer)
  if (n === undefined) return { ok: false, note: `没看到数字。「${what}」请给一个数值，例：${what} 15000。` }
  if (n < min || n > max) return { ok: false, note: `${n} 不像合理的${what}（预期 ${min}–${max}）。请核对后重答。` }
  return { ok: true }
}

function ratio(answer: string): AnswerCheck {
  const n = firstNumber(answer)
  if (n === undefined) return { ok: false, note: '没看到数字。重复率阈值请给百分数，例：15%。' }
  if (n <= 0 || n > 60) return { ok: false, note: `${n}% 不像合理的重复率阈值（预期 0–60%）。请核对学校文件。` }
  return { ok: true }
}

interface ParsedDate {
  /** 缺省表示答案只写了「3月1日」这种不带年份的写法。 */
  year?: number
  month: number
  day: number
}

/** 解析 `2026-03-01` / `2026/3/1` / `2026年3月1日` / `3月1日`。 */
function parseDate(answer: string): ParsedDate | undefined {
  const withYear = /(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?/.exec(answer)
  if (withYear !== null) {
    return { year: Number(withYear[1]), month: Number(withYear[2]), day: Number(withYear[3]) }
  }
  const noYear = /(\d{1,2})\s*月\s*(\d{1,2})\s*日?/.exec(answer)
  if (noYear !== null) return { month: Number(noYear[1]), day: Number(noYear[2]) }
  return undefined
}

/**
 * 日期合理性检查。只拦「明显不可能」的日期（如 2026-13-45），
 * 不判断日期是否已过——过期提醒是台账的职责，不是追问的职责。
 */
export function validateDeadline(answer: string, now: Date = new Date()): AnswerCheck {
  const d = parseDate(answer)
  if (d === undefined) {
    return { ok: false, note: '没看到日期。请用 YYYY-MM-DD 或「2026年3月1日」这样的写法。' }
  }
  if (d.month < 1 || d.month > 12 || d.day < 1 || d.day > 31) {
    return { ok: false, note: `「${d.month} 月 ${d.day} 日」不是合法日期，请核对。` }
  }
  if (d.year !== undefined) {
    const thisYear = now.getFullYear()
    if (d.year < thisYear - 1 || d.year > thisYear + 6) {
      return { ok: false, note: `年份 ${d.year} 超出合理区间（${thisYear - 1}–${thisYear + 6}），请核对。` }
    }
  } else {
    return { ok: true, note: '已记录月日；未写年份，请确认是否为本学年日期。' }
  }
  return { ok: true }
}

function yearRange(answer: string): AnswerCheck {
  const years = (answer.match(/\d{4}/g) ?? []).map(Number)
  if (years.length === 0) return { ok: true, note: '未写年限；建议补一句「近 5 年文献不少于一半」，引用检查时要用。' }
  const from = years[0]!
  if (from < 1950 || from > 2100) return { ok: false, note: `年份 ${from} 不像合理区间下限，请核对。` }
  return { ok: true }
}

function citationFormat(answer: string): AnswerCheck {
  const t = answer.trim()
  if (t.length === 0) return { ok: false, note: '答案为空。' }
  const hit = /7714|GB|APA|MLA|IEEE|ACM|哈佛|学校模板|按学校|模板/.test(t)
  if (!hit) return { ok: true, note: '无法从答案判定标准号。请确认是「GB/T 7714」还是学校模板里的自有格式——这决定引用列表的排版。' }
  return { ok: true }
}

function fileOrNone(answer: string): AnswerCheck {
  const t = answer.trim()
  if (t.length === 0) return { ok: false, note: '答案为空。' }
  if (/^(无|没有|暂无|未提供|未拿到|找不到|不知道|不清楚|无模板|没有模板)/.test(t)) {
    return { ok: true, note: '按「无学校模板」处理：构建论文时走通用过渡模板，并在产出里显式标注。若之后拿到模板，用同一问题重答一次即可。' }
  }
  if (!/\.(docx?|dotx?|pdf|md|txt)\b/i.test(t) && !/[\\/]/.test(t)) {
    return { ok: false, note: `「${t}」看起来不是文件路径。请给出文件在工作区里的相对路径（例：00-管理/学校模板.docx），或回「没有」。` }
  }
  return { ok: true }
}

function pathOrNone(answer: string): AnswerCheck {
  const t = answer.trim()
  if (t.length === 0) return { ok: false, note: '答案为空。' }
  if (/^(无|没有|暂无|还没有|未开始|从零|待开发)/.test(t)) {
    return { ok: true, note: '按「尚无代码」处理：实现阶段从零开始，进度台账里的实现任务按新项目排。' }
  }
  if (!/[\\/]/.test(t) && !/\.(zip|tar|gz)\b/i.test(t)) {
    return { ok: false, note: `「${t}」不像路径或压缩包。请给出目录（例：01-材料/代码/），或回「还没有」。` }
  }
  return { ok: true }
}

function yesNo(answer: string): AnswerCheck {
  const t = answer.trim()
  if (/^(有|是|已|已经|yes|y|没有|无|否|还没|尚未|未|no|n|部分)/i.test(t)) return { ok: true }
  return { ok: true, note: '未识别为「有/没有」。请直接回答「有」或「没有」，并补一句现状——实验结论只能来自真实运行结果。' }
}

function topicSource(answer: string): AnswerCheck {
  const t = answer.trim()
  const fromAdvisor = /(导师|老师|指导教师|课题|给定|指定|分配)/.test(t)
  const selfPicked = /(自选|自己|自主|我定|自拟)/.test(t)
  if (!fromAdvisor && !selfPicked) {
    return { ok: true, note: '没看出题目是导师给定还是自选。这不影响记录，但答辩常问「为什么做这个题」，建议写清来源。' }
  }
  if (selfPicked && !fromAdvisor) {
    return { ok: true, note: '判定为自选题目：请把最终题目原文补全（含副标题），它是后续所有产出的标题来源。' }
  }
  return { ok: true }
}

function paperCount(answer: string): AnswerCheck {
  const n = firstNumber(answer)
  if (n === undefined) return { ok: false, note: '没看到数字。请给中文文献与外文文献的最小篇数，例：中文 15 篇、外文 5 篇。' }
  if (n < 3 || n > 500) return { ok: false, note: `${n} 篇不像合理的文献数量下限（预期 3–500）。请核对学校要求。` }
  return { ok: true }
}

function ratioSum(answer: string): AnswerCheck {
  const nums = (answer.match(/\d+/g) ?? []).map(Number)
  const counts = nums.filter(n => n >= 500)
  if (counts.length === 0) return { ok: false, note: '没看到字数。请给全文总字数与各章分配，例：全文 15000，绪论 2000。' }
  const major = counts.filter(n => n >= 3000)
  const sum = major.reduce((a, b) => a + b, 0)
  const total = counts[0]!
  if (major.length >= 3 && sum > total * 1.5) {
    return { ok: false, note: `各章字数合计（约 ${sum}）明显超过总字数（${total}）。请核对分配，避免评审时对不上。` }
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// 问题库
// ---------------------------------------------------------------------------

/**
 * 追问问题库。分节顺序即 {@link INTAKE_SECTIONS} 的顺序。
 *
 * `required: true` 的问题不答就无法 `done`；其余问题可以 `skip`（须给理由）。
 */
export const QUESTIONS: readonly IntakeQuestion[] = [
  // ---- 学校与规范 ----
  {
    id: 'school.name',
    section: '学校与规范',
    ask: '你的学校、学院和专业全称是什么？（例：XX大学 计算机学院 软件工程）',
    why: '封面、页眉、开题报告抬头都要逐字一致；写错一个字就要重新生成全套 docx，格式检查也过不了。',
    affects: ['格式检查', '答案PPT'],
    answerShape: '学校 + 学院 + 专业全称，例：XX大学 计算机学院 软件工程',
    required: true,
    hint: '看学生证、教务系统个人信息页，或往届同专业论文封面的写法（连"学院"和"系"的区别都要一致）。',
    validate: a => text(a, 4),
    priority: 1,
  },
  {
    id: 'school.degree',
    section: '学校与规范',
    ask: '你的学位类型和层次是什么？（本科/硕士/博士，学术型还是专业型）',
    why: '本科毕设与硕士学位论文的字数下限、章节结构、封面模板都不同；判错层会把整篇论文的结构带偏。',
    affects: ['格式检查', '字数分配', '答辩问答'],
    answerShape: '层次 + 类型，例：本科（工学学士）/ 硕士（专业型）',
    required: true,
    hint: '问导师最准；也可看培养方案里的"学位授予"一栏。',
    validate: a => text(a, 2),
    priority: 1,
  },
  {
    id: 'school.template',
    section: '学校与规范',
    ask: '学校/学院的论文格式模板文件拿到了吗？拿到就给我它在工作区里的路径；没有就回「没有」。',
    why: '没有模板就只能用通用过渡排版，最终仍需按学校模板重排一遍封面、标题层级和参考文献样式——这一步返工量最大。',
    affects: ['格式检查', '引用规范'],
    answerShape: '文件相对路径（例：00-管理/学校模板.docx），或「没有」',
    required: true,
    hint: '教务处/研究生院网站"下载专区"、学院群文件、导师发的压缩包；学长学姐的模板有时更新更及时。',
    validate: fileOrNone,
    priority: 1,
  },
  {
    id: 'school.rule.ai',
    section: '学校与规范',
    ask: '学校对 AI 使用有明文规定吗？原文怎么说的？（没有明文规定也请说明）',
    why: '决定能写到什么程度、哪些段落必须完全手写、自查报告要怎么写；踩线会直接判定学术不端，不是格式问题。',
    affects: ['原创性', '格式检查', '答辩问答'],
    answerShape: '「有：<规定要点原文摘录>」或「没有明文规定」，附出处（文件/通知名）',
    required: true,
    hint: '找《毕业设计（论文）工作管理办法》《学术道德规范》和导师转发的通知，摘录原文更好。',
    validate: a => text(a, 4),
    priority: 1,
  },
  {
    id: 'school.rule.numbering',
    section: '学校与规范',
    ask: '图、表、公式的编号规范有要求吗？（例：图 3-1 / 图 3.1；公式按章编号）',
    why: '编号体系一旦定了就不能中途改，否则全文交叉引用、图表清单一并作废；格式检查会逐条比对。',
    affects: ['格式检查'],
    answerShape: '编号写法 + 是否有章号，例：图 3-1、表 3-1、公式 (3-1)；没有规定就说「没有」',
    required: false,
    hint: '翻模板正文里的示例图注；模板没有就按学院常见做法（图 章-序）并在规格里记下来。',
    priority: 2,
  },

  // ---- 课题与目标 ----
  {
    id: 'topic.title',
    section: '课题与目标',
    ask: '论文题目（或课题方向）的原文是什么？有副标题也一并写上。',
    why: '题目是所有产出的标题来源：封面、页眉、开题报告、PPT、答辩问题都从它派生，改了题目等于全套返工。',
    affects: ['格式检查', '答案PPT', '答辩问答'],
    answerShape: '题目原文，例：基于知识图谱的校园问答系统设计与实现',
    required: true,
    hint: '看选题确认书/任务书；还没定的先说方向，如"想做推荐系统"，我按方向记录并标注待定。',
    validate: a => text(a, 4),
    priority: 1,
  },
  {
    id: 'topic.source',
    section: '课题与目标',
    ask: '这个题目是导师给定的，还是你自己选的？',
    why: '自选题目要额外准备"为什么选它/工作量够不够"的论证（G1 选题拍板必问）；导师给定的题则以任务书为准，改动要先报备。',
    affects: ['答辩问答'],
    answerShape: '「导师给定」或「自选」，自选请补一句选题理由',
    required: false,
    hint: '看任务书是谁填的、有没有"自拟题目"字样。',
    validate: topicSource,
    priority: 2,
  },
  {
    id: 'scope.deliverable',
    section: '课题与目标',
    ask: '最终交付物是什么？（只要论文，还是论文 + 可运行系统 + 演示？）',
    why: '决定工作量口径与章节结构：纯论文型不需要系统实现章，而"系统 + 论文"必须留可运行证据，否则测试章无据可写。',
    affects: ['答辩问答', '答案PPT'],
    answerShape: '交付物清单，例：论文 + 可运行 Web 系统 + 答辩 PPT + 演示视频',
    required: false,
    hint: '看任务书"成果形式"一栏。',
    priority: 2,
  },
  {
    id: 'scope.wordcount',
    section: '课题与目标',
    ask: '正文（不含参考文献附录）要求多少字？如果各章有分配也一并说。',
    why: '字数决定章节篇幅与文献数量：不够会被扣分，超了评审会挑"注水"；各章分配还是逐章验收（G2）的量化标准。',
    affects: ['字数分配', '格式检查'],
    answerShape: '总量 + 可选各章，例：全文 15000 字，绪论 2000、测试 1500',
    required: false,
    hint: '任务书/学院文件里通常有"不少于 1.5 万字"；没有分配就按七章比例先定，再让导师确认。',
    validate: ratioSum,
    priority: 1,
  },
  {
    id: 'scope.core',
    section: '课题与目标',
    ask: '这个系统最核心的功能是什么？一句话说清它解决什么问题。',
    why: '核心功能决定设计章的主线、测试章的用例和答辩的第一问；说不清就会出现"功能很多但都不深"的典型扣分点。',
    affects: ['答辩问答'],
    answerShape: '一句话：「给谁用 + 解决什么问题 + 关键手段」',
    required: false,
    hint: '问自己：如果只能保留一个功能，是哪个？',
    priority: 2,
  },

  // ---- 时间线 ----
  {
    id: 'deliver.timeline',
    section: '时间线',
    ask: '开题、中期、查重截止、答辩这四个时间点分别是什么时候？说不出的写「不知道」。',
    why: '时间线决定每周该做什么：没有截止日期就无法判断"能不能按时定稿"，也无法在逾期时提醒你。',
    affects: ['答辩问答'],
    answerShape: '尽量给日期，例：开题 2026-01-10，中期 2026-03-20，查重 2026-05-01，答辩 2026-05-20',
    required: true,
    hint: '学院发的《毕业设计日程安排》表；找不到就先把已知的一个日期写上，其余写"不知道"。',
    validate: a => {
      const known = /不知道|不确定|待定|未定|说不清/.test(a)
      if (known) return { ok: true, note: '已记录「部分日期未知」。请尽快补齐——没有截止日期就无法排出每周计划。' }
      return validateDeadline(a)
    },
    priority: 1,
  },

  // ---- 系统与数据 ----
  {
    id: 'tech.stack',
    section: '系统与数据',
    ask: '技术栈定了吗？大概用了哪些语言、框架、数据库？',
    why: '技术栈决定设计章怎么写、环境怎么搭、答辩会被问哪些取舍（"为什么用它不用它"是必问题）。',
    affects: ['答辩问答'],
    answerShape: '语言 + 主要框架 + 数据库，例：Python + Django + MySQL；没定就说「没定」',
    required: false,
    hint: '看已有代码的依赖文件（package.json / requirements.txt / pom.xml）。',
    priority: 2,
  },
  {
    id: 'tech.code',
    section: '系统与数据',
    ask: '已有代码在哪里？（给出目录或压缩包路径；还没写就回「还没有」）',
    why: '有代码就能直接对齐实现章与测试章的写法；不知道代码在哪，实现章只能凭空描述，最容易被判定造假。',
    affects: ['答辩问答'],
    answerShape: '相对路径，例：01-材料/代码/ 或 01-材料/源码.zip；没有就回「还没有」',
    required: false,
    hint: 'git 仓库地址、压缩包、导师给的基础工程都算；注意别把 .git 目录整个塞进论文仓库。',
    validate: pathOrNone,
    priority: 2,
  },
  {
    id: 'data.source',
    section: '系统与数据',
    ask: '实验/测试数据从哪来？（自己采集、公开数据集、模拟生成、还是系统运行日志）',
    why: '数据来源决定测试章能不能写"可复现"：公开数据集要给名称版本，自采集要说明采集过程，否则结论无法被验证。',
    affects: ['答辩问答'],
    answerShape: '来源 + 名称/规模，例：公开数据集 MovieLens-1M；或自采集 500 条问卷',
    required: false,
    hint: '数据集官网的引用格式也一并记下来，引用章要用。',
    priority: 2,
  },
  {
    id: 'data.real',
    section: '系统与数据',
    ask: '现在已经有真实运行/测试结果了吗？还是数据还没跑出来？',
    why: '结论章与测试章只能写真实跑出来的数；没有结果就先占位标注"待补"，绝不允许编造——编造数据是学术不端红线。',
    affects: ['答辩问答'],
    answerShape: '「有：<结果在哪>」或「没有：<计划什么时候跑>」',
    required: true,
    hint: '有截图/日志/CSV 就在答案里给出路径，测试章直接引用。',
    validate: yesNo,
    priority: 1,
  },

  // ---- 文献与引用 ----
  {
    id: 'ref.requirement',
    section: '文献与引用',
    ask: '参考文献有数量要求吗？对年份有要求吗？（例：中文 15 篇、外文 5 篇，近五年不少于一半）',
    why: '数量不够或年份太旧会在文献综述和答辩上直接扣分；这些要求是筛选文献的硬条件，不是写的时候再补。',
    affects: ['引用规范'],
    answerShape: '篇数下限 + 年份要求，例：至少 20 篇，其中外文 5 篇、近五年 10 篇',
    required: false,
    hint: '任务书/学院文件；没有明确要求就按"本科≥15 篇、外文≥3 篇、近五年≥1/3"先定，并让导师确认。',
    validate: paperCount,
    priority: 2,
  },
  {
    id: 'ref.format',
    section: '文献与引用',
    ask: '引用格式要求是哪一种？（GB/T 7714 还是学校模板里的自有格式）',
    why: '引用格式决定 refs.bib 的排版与正文标注方式（顺序编码 vs 著者-出版年）；中途换格式等于全文引用重排。',
    affects: ['引用规范', '格式检查'],
    answerShape: '标准号 + 标注方式，例：GB/T 7714-2015 顺序编码制（上标数字）',
    required: true,
    hint: '看学校模板里"参考文献"一节的示例；问导师或学长最省事。',
    validate: citationFormat,
    priority: 2,
  },
  {
    id: 'ref.samples',
    section: '文献与引用',
    ask: '有往届同专业学长的论文可以给我看看吗？（给路径或说「没有」）',
    why: '同校同专业的往届论文是格式与篇幅的现实基准：章节怎么分、图表多少张、评审口味，比任何说明文件都准。',
    affects: ['格式检查', '引用规范', '答辩问答'],
    answerShape: '文件路径（例：01-材料/往届论文/）或「没有」',
    required: false,
    hint: '知网/万方按"作者单位 + 专业"检索学位论文；学院资料室、导师手里通常也有。',
    priority: 3,
  },

  // ---- 交付形式 ----
  {
    id: 'plag.system',
    section: '交付形式',
    ask: '学校用哪个查重系统？重复率红线是多少？',
    why: '不同系统（知网/维普/PaperPass）对同一段文字的判定不同，阈值决定降重的目标线；线不清楚，降重就是白改。',
    affects: ['原创性'],
    answerShape: '系统名 + 阈值，例：知网 PMLC，全文重复率 ≤15%',
    required: false,
    hint: '学院通知里通常写明"知网查重，≤15%"；不确定就先问导师助理。',
    validate: ratio,
    priority: 3,
  },
  {
    id: 'plag.rule',
    section: '交付形式',
    ask: '重复率怎么算、有没有特殊规定？（例：全文 vs 正文、单章是否也查、是否允许引用自己以前的论文）',
    why: '同一篇论文按全文算和按章节算结论可能相反；不搞清口径就会把时间花在不需要改的章节上。',
    affects: ['原创性'],
    answerShape: '计算口径 + 特殊规定，例：按全文算，致谢与参考文献不计入',
    required: false,
    priority: 3,
  },
  {
    id: 'defense.format',
    section: '交付形式',
    ask: '答辩什么形式？PPT 有没有页数或时长限制，是不是盲审？',
    why: '时长决定 PPT 页数与内容密度（10 分钟约 12–15 页），盲审则要删掉所有可识别身份的信息；这两点会整体改变 PPT 与讲稿。',
    affects: ['答案PPT', '答辩问答'],
    answerShape: '形式 + 页数/时长 + 是否盲审，例：现场答辩，PPT ≤15 页，8 分钟，非盲审',
    required: false,
    hint: '学院答辩通知；没有明确要求就按"12 页 + 8 分钟"起稿，再按实际调整。',
    priority: 3,
  },
]

// ---------------------------------------------------------------------------
// 查询与排序
// ---------------------------------------------------------------------------

const BY_ID: ReadonlyMap<string, IntakeQuestion> = new Map(QUESTIONS.map(q => [q.id, q]))

export function questionById(id: string): IntakeQuestion | undefined {
  return BY_ID.get(id)
}

export function listRequired(): IntakeQuestion[] {
  return QUESTIONS.filter(q => q.required)
}

/** 全部问题 id（现状报告用）。 */
export function allQuestionIds(): string[] {
  return QUESTIONS.map(q => q.id)
}

/** 某问题是否已被回答（跳过不算回答）。 */
export function isAnswered(state: IntakeState, q: IntakeQuestion): boolean {
  return state.answers[q.id] !== undefined
}

/** 某回答是否还需要用户确认（材料推断出来的答案）。 */
export function needsConfirm(state: IntakeState, q: IntakeQuestion): boolean {
  const rec = state.answers[q.id]
  return rec !== undefined && !rec.confirmed
}

// ---------------------------------------------------------------------------
// 材料感知
// ---------------------------------------------------------------------------

function entryPath(e: MaterialEntry): string {
  return e.path.replace(/\\/g, '/')
}

function entryLabel(e: MaterialEntry): string {
  return entryPath(e).replace(/^.*\//, '')
}

/** 材料条目的类型/文件名里是否命中任一关键词（大小写不敏感）。 */
function matches(e: MaterialEntry, words: readonly string[]): boolean {
  const hay = `${e.kind} ${entryPath(e)}`.toLowerCase()
  return words.some(w => hay.includes(w.toLowerCase()))
}

/** 找第一份学校格式模板：文件名/类型里出现"模板/格式/规范"，或 kind 明确为学校模板。 */
export function findTemplateMaterial(materials: MaterialSummary): MaterialEntry | undefined {
  const strong = materials.items.find(e => matches(e, ['学校模板', '格式模板', '论文模板', '模板', '格式要求', '规范']))
  if (strong !== undefined) return strong
  // 次优：上传了 docx，但没明说是模板——只在文件名像规范时才认。
  return materials.items.find(e => /\.(docx?|dotx?)$/i.test(entryPath(e)) && matches(e, ['要求', '说明', '手册', '文件']))
}

function findMaterial(materials: MaterialSummary, words: readonly string[]): MaterialEntry | undefined {
  return materials.items.find(e => matches(e, words))
}

/** 材料推断出的一条答案：值 + 依据 + 是否还需要用户确认。 */
export interface MaterialAnswer {
  readonly value: string
  readonly evidence: string
  /** true = 必须有用户确认才算数（规格里标「待确认」）。 */
  readonly needsConfirm: boolean
}

/** 材料感知结果。 */
export interface MaterialInsight {
  /**
   * 材料已给出答案、但仍需用户确认的问题。
   * 这类问题会以「已由材料回答，待用户确认」的形态问一次，用户确认或纠正后落盘。
   */
  readonly autoAnswers: ReadonlyMap<string, MaterialAnswer>
  /**
   * 材料已能安全推断、不必再打扰用户的问题。
   * 这些 id 不会出现在追问队列里（规格里标注来源为「材料推断」）。
   */
  readonly suppress: ReadonlySet<string>
}

/**
 * 从材料清单摘要推断哪些问题可以免问 / 自动回答。
 *
 * 纯函数：同样的清单与状态永远给出同样结果。清单缺失（`found:false`）时
 * 什么都不推断，一切照常提问——**宽容优先**，不猜。
 */
export function materialInsight(materials: MaterialSummary): MaterialInsight {
  const autoAnswers = new Map<string, MaterialAnswer>()
  const suppress = new Set<string>()

  if (!materials.found || materials.items.length === 0) return { autoAnswers, suppress }

  const template = findTemplateMaterial(materials)
  if (template !== undefined) {
    autoAnswers.set('school.template', {
      value: entryPath(template),
      evidence: `材料清单里的「${entryLabel(template)}」（类型：${template.kind || '未标注'}）看起来就是学校格式模板`,
      needsConfirm: true,
    })
  }

  const aiRule = findMaterial(materials, ['AI使用', 'AI规定', 'ai规定', '学术道德', '学术诚信', '学校规定', '管理办法'])
  if (aiRule !== undefined) {
    autoAnswers.set('school.rule.ai', {
      value: `见材料：${entryPath(aiRule)}`,
      evidence: `材料清单里的「${entryLabel(aiRule)}」属于学校规定类文件，其中可能含 AI 使用条款`,
      needsConfirm: true,
    })
  }

  const samples = materials.items.filter(e => matches(e, ['往届', '学长', '学姐', '参考论文', '学位论文', '范文']))
  if (samples.length > 0) {
    autoAnswers.set('ref.samples', {
      value: samples.map(e => entryPath(e)).join('、'),
      evidence: `材料清单里有 ${samples.length} 份往届/参考论文（如「${entryLabel(samples[0]!)}」）`,
      needsConfirm: true,
    })
  }

  // 已从材料安全推断的：数据类问题有数据文件即视为"已有"，写作阶段自然会用到具体文件。
  const dataFiles = materials.items.filter(e => /\.(xlsx?|csv|json|txt|db|sqlite)$/i.test(entryPath(e)))
  if (dataFiles.length > 0) {
    autoAnswers.set('data.source', {
      value: `${dataFiles.map(e => entryPath(e)).join('、')}（导入工作区的数据文件）`,
      evidence: `材料清单里有 ${dataFiles.length} 个数据文件`,
      needsConfirm: true,
    })
    suppress.add('data.source')
  }

  const codeFiles = materials.items.filter(e => /\.(zip|tar|gz|jar|whl)$/i.test(entryPath(e)))
  const codeDir = materials.items.find(e => matches(e, ['代码', '源码', 'source', 'src']))
  const codeHit = codeDir ?? codeFiles[0]
  if (codeHit !== undefined) {
    autoAnswers.set('tech.code', {
      value: entryPath(codeHit),
      evidence: `材料清单里的「${entryLabel(codeHit)}」是代码/源码类材料`,
      needsConfirm: true,
    })
    suppress.add('tech.code')
  }

  const stackFile = materials.items.find(e => /(package\.json|requirements\.txt|pom\.xml|build\.gradle|cargo\.toml|go\.mod|\.csproj)$/i.test(entryPath(e)))
  if (stackFile !== undefined) {
    autoAnswers.set('tech.stack', {
      value: `见依赖清单：${entryPath(stackFile)}（尚未解析，需用户确认后补全技术栈）`,
      evidence: `材料清单里有依赖清单文件「${entryLabel(stackFile)}」`,
      needsConfirm: true,
    })
  }

  return { autoAnswers, suppress }
}

/**
 * 材料自动回答里的「确认清单」：`autoAnswers` 中尚未被用户确认的部分。
 * 这些是让「一次到位」落地的关键——不重复问，但也不替用户拍板。
 */
export function pendingConfirmations(state: IntakeState, insight: MaterialInsight): IntakeQuestion[] {
  const out: IntakeQuestion[] = []
  for (const id of insight.autoAnswers.keys()) {
    const q = questionById(id)
    if (q === undefined) continue
    if (!state.answers[id]?.confirmed) out.push(q)
  }
  return out
}

// ---------------------------------------------------------------------------
// 裁剪与选取
// ---------------------------------------------------------------------------

/** 排序用的一个排名元组：越小越先问。 */
function rankTuple(q: IntakeQuestion, ctx: IntakeContext, state: IntakeState, insight: MaterialInsight, index: number): number[] {
  const rec = state.answers[q.id]
  const auto = insight.autoAnswers.has(q.id)
  // 材料已经给出答案、只差用户点头（含尚未落盘的自动回答）——最便宜，先问。
  const mustConfirm = auto && (rec === undefined || !rec.confirmed)
  const blockingRequired = q.required && (rec === undefined || rec.valid === false)
  let bucket: number
  if (mustConfirm) bucket = 0
  else if (blockingRequired) bucket = 1 // 拦路的必答项
  else if (rec === undefined) bucket = 2 // 普通未答
  else bucket = 3                       // 已答待补（非阻塞）
  return [bucket, affectRank(q, ctx.stage), q.priority, index]
}

function compareRank(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]!
    const y = b[i]!
    if (x !== y) return x - y
  }
  return 0
}

/**
 * 当前应该问的下一个问题；没有可问的返回 undefined。
 *
 * 规则（按优先级）：
 * 1. 材料已给出答案、只差用户确认的；
 * 2. `required` 且未答（或格式不合格）的；
 * 3. 其余未答的，按「当前阶段命中的产出物 → priority → 问题库顺序」；
 * 4. 已跳过的不再问（要改就显式重答）。
 */
export function nextQuestion(state: IntakeState, ctx: IntakeContext): IntakeQuestion | undefined {
  const insight = materialInsight(ctx.materials)
  let best: IntakeQuestion | undefined
  let bestRank: number[] | undefined
  let index = 0
  for (const q of QUESTIONS) {
    const current = index
    index += 1
    if (insight.suppress.has(q.id)) continue
    const rec = state.answers[q.id]
    if (rec !== undefined && rec.confirmed) continue
    if (rec === undefined && state.skipped.includes(q.id)) continue
    const rank = rankTuple(q, ctx, state, insight, current)
    if (rank[0] === 3) continue // 已答且合格的非必答项：不再打扰
    if (bestRank === undefined || compareRank(rank, bestRank) < 0) {
      best = q
      bestRank = rank
    }
  }
  return best
}

/**
 * 问题队列快照（不含已确认的答案）：用于报告「还差什么」。
 * 返回顺序与 {@link nextQuestion} 的选取顺序一致，但不做 maxQuestions 裁剪。
 */
export function questionQueue(state: IntakeState, ctx: IntakeContext): IntakeQuestion[] {
  const insight = materialInsight(ctx.materials)
  const entries: Array<{ q: IntakeQuestion; rank: number[] }> = []
  let index = 0
  for (const q of QUESTIONS) {
    const current = index
    index += 1
    if (insight.suppress.has(q.id)) continue
    const rec = state.answers[q.id]
    if (rec !== undefined && rec.confirmed) continue
    if (rec === undefined && state.skipped.includes(q.id)) continue
    const rank = rankTuple(q, ctx, state, insight, current)
    if (rank[0] === 3) continue
    entries.push({ q, rank })
  }
  entries.sort((a, b) => compareRank(a.rank, b.rank))
  return entries.map(e => e.q)
}

/** 阻塞项：`required` 但未答、或已答但格式不合格（`valid === false`）。 */
export function blockingRequired(state: IntakeState): IntakeQuestion[] {
  return listRequired().filter(q => {
    const rec = state.answers[q.id]
    return rec === undefined || rec.valid === false
  })
}

/** 进度：已答（含未确认）/ 必答总数。 */
export function progress(state: IntakeState): { answered: number; total: number; required: number; confirmed: number } {
  const required = listRequired()
  const answered = QUESTIONS.filter(q => state.answers[q.id] !== undefined).length
  const confirmed = QUESTIONS.filter(q => state.answers[q.id]?.confirmed === true).length
  const doneRequired = required.filter(q => state.answers[q.id] !== undefined).length
  return { answered: doneRequired, total: required.length, required: required.length, confirmed }
}

/** 一次问答循环可推进的问题数（`maxQuestions` 上限的裁剪视图）。 */
export function clampQueue(queue: readonly IntakeQuestion[], maxQuestions: number): IntakeQuestion[] {
  const limit = Math.max(1, Math.floor(maxQuestions))
  return queue.slice(0, limit)
}

/** 组装一个规格上下文：材料感知 + 阶段。 */
export function makeContext(materials: MaterialSummary, stage: string | undefined): IntakeContext {
  return { materials, stage: stage === undefined || stage === '' ? DEFAULT_STAGE : stage }
}
