/**
 * 答辩幻灯计划（`thesis_slides action=outline` 的核心）。
 *
 * 产品决策：**不自研 pptx 生成器**。本模块把真实素材变成结构化的《幻灯片计划》
 * （SlidePlan），由 `marp.ts` 渲染为标准 Marp Markdown，再交给外部转换器
 * （marp-cli / pandoc）成稿。计划里的每一条要点都带**证据锚点**，指向工作区里
 * 真实存在的文件/章节/数据——这是"零编造"红线在答辩环节的落地。
 *
 * 两条输入路径：
 * 1. `07-答辩/答辩素材.md`（由 `thesis_defense` 生成）——优先；
 * 2. 素材不存在时回退到 `06-论文/章节/*.md` 的标题与要点，并在结果里标注
 *    "素材未生成，建议先跑 thesis_defense"，**不编造系统细节**。
 *
 * @module dsh-thesis/ppt
 */

import * as nodePath from 'node:path'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { CHAPTER_META } from '../paper/lib/layout.ts'

/** 幻灯页的语义类型（渲染与检查共用）。 */
export type SlideKind =
  | 'cover'
  | 'toc'
  | 'background'
  | 'status'
  | 'content'
  | 'route'
  | 'design'
  | 'impl'
  | 'test'
  | 'conclusion'
  | 'innovation'
  | 'thanks'

/** 听众档位：本科（默认）/ 硕士。影响详略与时长估算。 */
export type Audience = 'undergrad' | 'master'

/** 单条要点的硬上限（字符）：超出自动截断并标记。 */
export const MAX_BULLET_CHARS = 30
/** 单页标题的硬上限（字符）。 */
export const MAX_TITLE_CHARS = 20
/** 单页要点条数区间。 */
export const MIN_BULLETS_PER_SLIDE = 3
export const MAX_BULLETS_PER_SLIDE = 6
/** 每页预计讲述秒数区间（本科）。 */
export const SECONDS_PER_SLIDE_MIN = 40
export const SECONDS_PER_SLIDE_MAX = 60

/** 系统实现页的证据锚点根目录（真实代码位置）。 */
export const CODE_ROOT = '04-实现'
/** 实验结果的证据锚点根目录。 */
export const RESULT_ROOT = '05-实验测试/结果'

/** 要点模板：正文 + 证据锚点。 */
export interface BulletSpec {
  readonly text: string
  readonly anchor?: string
}

/** 页面模板（解析素材后的呈现结构）。 */
export interface SlideSpec {
  readonly kind: SlideKind
  readonly title: string
  readonly bullets: readonly BulletSpec[]
  /** 讲稿要点（渲染为 HTML 注释，Marp 演示者备注兼容）。 */
  readonly note: string
}

/** 解析后的单条要点。 */
export interface PlanBullet {
  readonly text: string
  /** 超长被自动截断（原文另见 `original`）。 */
  readonly truncated: boolean
  /** 被截断前的原文（仅在 truncated=true 时出现）。 */
  readonly original?: string
  /** 证据锚点：相对工作区根的文件/章节/数据位置。 */
  readonly anchor?: string
}

/** 计划中的一页。 */
export interface PlannedSlide {
  readonly index: number
  readonly kind: SlideKind
  readonly title: string
  readonly bullets: readonly PlanBullet[]
  readonly note: string
}

/** 素材来源模式。 */
export type MaterialSource = 'defense-materials' | 'chapters'

/** 章节解析结果。 */
export interface ChapterDigest {
  readonly file: string
  readonly title: string
  readonly headings: readonly string[]
}

/** 技术选型条目。 */
export interface TechChoiceEntry {
  readonly item: string
  readonly choice: string
  readonly reason: string
  readonly alternative: string
}

/** 从答辩素材里解析出的结构化事实。 */
export interface DefenseMaterials {
  readonly title: string
  readonly chapters: readonly ChapterDigest[]
  readonly techChoices: readonly TechChoiceEntry[]
  readonly decisions: readonly string[]
  readonly testCases: number
  readonly resultFiles: readonly string[]
  readonly gitCommits?: number
  readonly bibCount?: number
}

/** 时长估算。 */
export interface PlanEstimate {
  /** 页数下限（每页秒数上限换算成分钟）。 */
  readonly minMinutes: number
  /** 页数上限（每页秒数下限换算成分钟）。 */
  readonly maxMinutes: number
  readonly secondsPerSlideMin: number
  readonly secondsPerSlideMax: number
  readonly advice: string
}

/** 幻灯片计划（纯函数产物，可直接序列化）。 */
export interface SlidePlan {
  readonly title: string
  readonly audience: Audience
  readonly pages: number
  readonly slides: readonly PlannedSlide[]
  readonly estimate: PlanEstimate
  /** 入参页码被夹到骨架允许的区间时给出说明。 */
  readonly pageAdjustment?: string
  /** 素材来源模式。 */
  readonly source: MaterialSource
  /** 素材缺失标注（无则为 undefined）。 */
  readonly note?: string
  /** 其它需要用户注意的事项。 */
  readonly warnings: readonly string[]
}

// ---------------------------------------------------------------------------
// 纯解析器
// ---------------------------------------------------------------------------

/** 去掉 Markdown 修饰（粗体、行内代码、列表符号），得到纯文本。 */
export function stripMarkdownInline(text: string): string {
  return text
    .replace(/^\s*(?:[-*+]|\d+[.、)])\s+/, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .trim()
}

/** 中文字符数（用于判断素材章节是否"已撰写"）。 */
export function cjkCount(text: string): number {
  return (text.match(/[\u4e00-\u9fff]/g) ?? []).length
}

/**
 * 截断单条要点：`limit` 字以内原样返回；超出则截到 `limit - 1` 并补省略号，
 * 保证总长不超过 limit，并把 `truncated` 标记为 true（原文保留在 `original`）。
 */
export function truncateBullet(text: string, limit: number = MAX_BULLET_CHARS): { text: string; truncated: boolean; original?: string } {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= limit) return { text: clean, truncated: false }
  const head = clean.slice(0, Math.max(1, limit - 1)).trimEnd()
  return { text: `${head}…`, truncated: true, original: clean }
}

/** 标题超长同样截断（20 字硬上限）。 */
export function truncateTitle(title: string, limit: number = MAX_TITLE_CHARS): string {
  const clean = title.replace(/\s+/g, ' ').trim()
  if (clean.length <= limit) return clean
  return `${clean.slice(0, Math.max(1, limit - 1)).trimEnd()}…`
}

/**
 * 解析 `07-答辩/答辩素材.md`（thesis_defense 的产物）。
 *
 * 容错原则：任何一段缺失都只是"该段没有事实"，绝不用默认值伪造内容。
 */
export function parseDefenseMaterials(markdown: string): DefenseMaterials {
  const lines = markdown.split(/\r?\n/)
  let title = ''
  const chapters: ChapterDigest[] = []
  const techChoices: TechChoiceEntry[] = []
  const decisions: string[] = []
  const resultFiles: string[] = []
  let testCases = 0
  let gitCommits: number | undefined
  let bibCount: number | undefined
  let section = ''
  let current: { file: string; title: string; headings: string[] } | undefined

  for (const raw of lines) {
    const line = raw.trim()
    if (line.startsWith('## ')) {
      section = line.slice(3).trim()
      current = undefined
      continue
    }
    if (line.startsWith('### ')) {
      // 章节概览的小节标题形如：`### 第 N 章 标题（M 字，引用 K 处）`
      if (section.startsWith('章节概览')) {
        const heading = line.slice(4).trim()
        const matched = /^第\s*(\S+)\s*章\s*(.*?)(?:[（(].*)?$/.exec(heading)
        const no = matched?.[1] ?? ''
        const name = (matched?.[2] ?? heading).trim()
        current = { file: no === '' ? name : `第 ${no} 章`, title: name, headings: [] }
        chapters.push(current)
      } else {
        current = undefined
      }
      continue
    }
    if (line === '' || line.startsWith('>')) continue

    if (section === '课题') {
      const plain = stripMarkdownInline(line)
      if (plain !== '' && title === '') title = plain
      continue
    }
    if (section.startsWith('章节概览')) {
      if (current !== undefined && line.startsWith('- ')) {
        const bullet = stripMarkdownInline(line)
        if (bullet !== '') current.headings.push(bullet)
      }
      continue
    }
    if (section.startsWith('技术选型')) {
      if (!line.startsWith('- ')) continue
      const body = stripMarkdownInline(line)
      const parts = body.split(/[：:]/)
      const item = parts[0]?.trim() ?? ''
      const choice = (parts[1] ?? '').split(/[（(]/)[0]?.trim() ?? ''
      const reasonMatch = /理由[：:]\s*([^；;]*)/.exec(body)
      const altMatch = /备选[：:]\s*([^；;]*)/.exec(body)
      if (item !== '') {
        techChoices.push({
          item,
          choice,
          reason: (reasonMatch?.[1] ?? '').trim(),
          alternative: (altMatch?.[1] ?? '').trim(),
        })
      }
      continue
    }
    if (section.startsWith('关键决定')) {
      if (line.startsWith('- ')) decisions.push(stripMarkdownInline(line))
      continue
    }
    if (section.startsWith('测试与数据')) {
      const cases = /测试用例[：:]\s*(\d+)/.exec(line)
      if (cases?.[1] !== undefined) testCases = Number.parseInt(cases[1], 10)
      const results = /结果文件[：:]\s*(.*)$/.exec(line)
      if (results?.[1] !== undefined) {
        const value = results[1].trim()
        if (value !== '' && !value.startsWith('（')) {
          for (const name of value.split(/[、,，]/)) {
            const clean = name.trim()
            if (clean !== '') resultFiles.push(clean)
          }
        }
      }
      continue
    }
    if (section.startsWith('工作量')) {
      const commits = /提交[：:]\s*(\d+)/.exec(line)
      if (commits?.[1] !== undefined) gitCommits = Number.parseInt(commits[1], 10)
      continue
    }
    if (section.startsWith('文献')) {
      const bib = /收录\s*(\d+)\s*条/.exec(line)
      if (bib?.[1] !== undefined) bibCount = Number.parseInt(bib[1], 10)
      continue
    }
  }

  return {
    title,
    chapters,
    techChoices,
    decisions,
    testCases,
    resultFiles,
    ...(gitCommits !== undefined ? { gitCommits } : {}),
    ...(bibCount !== undefined ? { bibCount } : {}),
  }
}

/**
 * 回退解析：从 `06-论文/章节/*.md` 提取章节标题与该章二三级小节标题。
 *
 * 这是"素材未生成"时的降级路径——只搬运论文章节里**已经写好**的标题，
 * 不推断、不补全任何系统细节。
 */
export function parseChapterFallback(files: readonly { readonly name: string; readonly text: string }[]): ChapterDigest[] {
  const digests: ChapterDigest[] = []
  for (const file of files) {
    const stem = file.name.replace(/\.md$/i, '')
    let title = stem
    const headings: string[] = []
    for (const raw of file.text.split(/\r?\n/)) {
      const line = raw.trim()
      const h1 = /^#\s+(.+)$/.exec(line)
      if (h1?.[1] !== undefined && title === stem) {
        title = stripMarkdownInline(h1[1]).replace(/^第\s*\S+\s*章\s*/, '')
        continue
      }
      const h2 = /^#{2,3}\s+(.+)$/.exec(line)
      if (h2?.[1] !== undefined) headings.push(stripMarkdownInline(h2[1]))
    }
    digests.push({ file: stem, title, headings })
  }
  return digests
}

// ---------------------------------------------------------------------------
// 骨架与素材映射
// ---------------------------------------------------------------------------

interface SkeletonEntry {
  readonly kind: SlideKind
  readonly title: string
  readonly bullets: readonly BulletSpec[]
  readonly note: string
}

/** 展开顺序的候选段落（含页面模板与素材填充规则）。 */
type SegmentId = 'background' | 'status' | 'route' | 'design' | 'impl' | 'test' | 'conclusion'

interface Segment {
  readonly id: SegmentId
  readonly expandable: boolean
  readonly page: (input: SegmentInput) => SkeletonEntry
}

interface SegmentInput {
  readonly planTitle: string
  readonly materials: DefenseMaterials
  readonly source: MaterialSource
  /** 同一段落内的第几页（从 0 开始）。 */
  readonly part: number
  /** 该段落的页数。 */
  readonly total: number
}

const UNDERGRAD_PAGES: readonly [number, number] = [10, 12]
const MASTER_PAGES: readonly [number, number] = [12, 16]

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min
  if (value > max) return max
  return value
}

function bulletsOrFallback(candidates: readonly BulletSpec[], anchor: string): BulletSpec[] {
  if (candidates.length > 0) return [...candidates]
  return [
    { text: '本页素材尚未生成', anchor },
    { text: '先跑 thesis_defense 再刷新', anchor },
    { text: '禁止编造系统细节与数据', anchor },
  ]
}

/**
 * 《答辩素材》的章节概览只记"第 N 章"，这里把它映射回真实章节文件名
 * （`06-论文/章节/04-系统设计.md`），使证据锚点落在**真实文件**上而不是虚构路径。
 */
function chapterFileOf(chapter: ChapterDigest): string {
  const direct = `${chapter.file}.md`
  if (CHAPTER_META.some(meta => direct === `${meta.file}.md`)) return direct
  const no = /第?\s*(\d+)/.exec(chapter.file)?.[1]
  const index = no !== undefined ? Number.parseInt(no, 10) - 1 : -1
  const meta = CHAPTER_META[index]
  return meta !== undefined ? `${meta.file}.md` : `${chapter.file}.md`
}

/** 按章标题关键词取该章的小节标题作为要点（素材里没有就返回空）。 */
function chapterBullets(materials: DefenseMaterials, keyword: RegExp, limit = 5): BulletSpec[] {
  const out: BulletSpec[] = []
  for (const chapter of materials.chapters) {
    if (!keyword.test(chapter.title)) continue
    for (const heading of chapter.headings) {
      if (out.length >= limit) break
      out.push({ text: heading, anchor: `06-论文/章节/${chapterFileOf(chapter)}` })
    }
  }
  return out
}

const SEGMENTS: readonly Segment[] = [
  {
    id: 'background',
    expandable: true,
    page: ({ planTitle, materials }) => {
      const bullets: BulletSpec[] = [
        { text: `课题来源：${planTitle}`, anchor: '00-管理/选题/选题确认书.md' },
      ]
      bullets.push(...chapterBullets(materials, /绪论/, 5))
      if (bullets.length < 3) {
        bullets.push(
          { text: '行业/场景的真正痛点是什么', anchor: '06-论文/章节/01-绪论.md#1.1' },
          { text: '现有做法为什么不够用', anchor: '06-论文/章节/01-绪论.md#1.1' },
        )
      }
      return {
        kind: 'background',
        title: '选题背景与意义',
        bullets: bullets.slice(0, MAX_BULLETS_PER_SLIDE),
        note: '先讲痛点再讲意义：一句话说明谁在什么场景下遇到什么问题；本页数据/结论必须能追到论文绪论。',
      }
    },
  },
  {
    id: 'status',
    expandable: true,
    page: ({ materials }) => ({
      kind: 'status',
      title: '国内外研究现状',
      bullets: bulletsOrFallback(
        chapterBullets(materials, /绪论|相关技术/, 5),
        '06-论文/章节/01-绪论.md#1.2',
      ),
      note: '一图带过：按主题讲 2-3 条主流路线，落点是"现有方案的不足 → 本课题要补的空白"；引用编号与论文一致。',
    }),
  },
  {
    id: 'route',
    expandable: false,
    page: () => ({
      kind: 'route',
      title: '研究内容与技术路线',
      bullets: [
        { text: '功能需求 FR 清单（见论文）', anchor: '03-设计/需求分析.md' },
        { text: '技术路线：分步实现（见开题报告）', anchor: '01-开题/开题报告.md#4' },
        { text: '关键难点与对应解法', anchor: '00-管理/决定日志.md' },
      ],
      note: '讲清"要做什么、怎么做"：2-3 条研究内容各一句目标，再给技术路线步骤图（与开题报告第 4 节一致）。',
    }),
  },
  {
    id: 'design',
    expandable: true,
    page: ({ materials, part, total }) => {
      const tables: readonly { readonly title: string; readonly bullets: readonly BulletSpec[]; readonly note: string }[] = [
        {
          title: '系统设计：总体架构',
          bullets: [
            { text: '分层架构与部署形态', anchor: '03-设计/系统设计.md#1' },
            { text: '架构图与论文图一致', anchor: '03-设计/系统设计.md#1' },
            { text: '关键模块划分与职责', anchor: '03-设计/系统设计.md#2' },
            { text: '模块间接口与数据流', anchor: '03-设计/系统设计.md#4' },
          ],
          note: '对着架构图讲一遍数据流：请求从哪进、经过哪些模块、落到哪些表；老师最容易在这里追问模块边界。',
        },
        {
          title: '系统设计：模块与数据库',
          bullets: [
            { text: '核心表结构与关系（ER）', anchor: '03-设计/系统设计.md#3' },
            { text: '接口设计：路径/参数/返回', anchor: '03-设计/系统设计.md#4' },
            { text: '非功能需求如何落地', anchor: '03-设计/需求分析.md#3' },
            { text: '选型理由一句话结论', anchor: '03-设计/技术选型论证.md' },
          ],
          note: '数据库页只讲 2-3 张关键表和它们的关系；非功能需求（性能/安全）各给一条已落地的措施。',
        },
      ]
      const page = tables[Math.min(part, tables.length - 1)]!
      const bullets = [...page.bullets]
      if (materials.techChoices.length > 0 && part === total - 1) {
        const first = materials.techChoices[0]!
        bullets.unshift({
          text: `${first.item}选型：${first.choice}`,
          anchor: '03-设计/技术选型论证.md',
        })
      }
      return { kind: 'design', title: page.title, bullets: bullets.slice(0, MAX_BULLETS_PER_SLIDE), note: page.note }
    },
  },
  {
    id: 'impl',
    expandable: true,
    page: ({ materials, part, total, source, planTitle }) => {
      const implBullets = chapterBullets(materials, /实现/, 12)
      const moduleBullet = implBullets[part]
      const title = total === 1 ? '系统实现' : (part === 0 ? '系统实现：总体' : `系统实现：模块 ${part}`)
      if (source === 'chapters') {
        const bullets: BulletSpec[] = [
          { text: `开发环境与关键技术：${planTitle}`, anchor: '06-论文/章节/05-系统实现.md#5.1' },
          ...(moduleBullet !== undefined ? [moduleBullet] : []),
          { text: '真实代码文件与关键函数', anchor: '06-论文/章节/05-系统实现.md' },
          { text: '关键设计取舍与理由', anchor: '00-管理/决定日志.md' },
          { text: '真实界面/接口截图', anchor: RESULT_ROOT },
        ]
        return {
          kind: 'impl',
          title,
          bullets: bulletsOrFallback(bullets.slice(0, MAX_BULLETS_PER_SLIDE), '06-论文/章节/05-系统实现.md'),
          note: '素材未生成时以论文"系统实现"章为依据；每页一个模块，讲"为什么这么写"，并准备好真实代码文件路径。',
        }
      }
      const bullets: BulletSpec[] = [
        {
          text: moduleBullet !== undefined ? `实现要点：${moduleBullet.text}` : '核心流程：从入口到落库',
          anchor: moduleBullet?.anchor ?? CODE_ROOT,
        },
        { text: '真实代码文件与关键函数', anchor: CODE_ROOT },
        { text: '关键设计取舍与理由', anchor: '00-管理/决定日志.md' },
        { text: '真实界面/接口截图', anchor: RESULT_ROOT },
      ]
      return {
        kind: 'impl',
        title,
        bullets: bullets.slice(0, MAX_BULLETS_PER_SLIDE),
        note: '这是老师看得最细的部分：每页一个模块，按"入口 → 关键函数 → 数据表"讲；代码片段必须来自 04-实现 的真实文件，现场能打开。',
      }
    },
  },
  {
    id: 'test',
    expandable: true,
    page: ({ materials }) => {
      const result = materials.resultFiles[0]
      const bullets: BulletSpec[] = [
        { text: `测试用例 ${materials.testCases > 0 ? `${materials.testCases} 个` : '见测试计划'}`, anchor: '05-实验测试/测试计划.md' },
        { text: '测试环境与复现步骤', anchor: '05-实验测试/测试计划.md' },
      ]
      if (result !== undefined) {
        bullets.push({ text: `真实结果：${result}`, anchor: `${RESULT_ROOT}/${result}` })
      } else {
        bullets.push({ text: '真实结果文件（结果/ 目录）', anchor: RESULT_ROOT })
      }
      bullets.push({ text: '失败用例与修复记录', anchor: '05-实验测试/测试计划.md' })
      return {
        kind: 'test',
        title: '实验与测试',
        bullets: bullets.slice(0, MAX_BULLETS_PER_SLIDE),
        note: '只讲真实跑出来的数据：测试环境、用例数、关键指标图表；准备好"这些数据怎么复现"的回答。',
      }
    },
  },
  {
    id: 'conclusion',
    expandable: false,
    page: ({ materials }) => ({
      kind: 'conclusion',
      title: '结论与展望',
      bullets: [
        { text: '系统已完成的核心功能', anchor: '06-论文/章节/07-总结与展望.md#7.1' },
        { text: '达到的设计目标与指标', anchor: '06-论文/章节/06-系统测试.md' },
        { text: '后续可扩展方向', anchor: '06-论文/章节/07-总结与展望.md#7.2' },
        ...(materials.gitCommits !== undefined ? [{ text: `开发过程 ${materials.gitCommits} 次提交`, anchor: 'git log' }] : []),
      ],
      note: '结论要短：已完成什么、达到什么指标、下一步做什么；与绪论"本文主要工作"逐条呼应。',
    }),
  },
]

const FIXED_HEAD: readonly ((input: { readonly planTitle: string }) => SkeletonEntry)[] = [
  ({ planTitle }) => ({
    kind: 'cover',
    title: '封面',
    bullets: [
      { text: planTitle, anchor: '00-管理/进度台账.md' },
      { text: '姓名：＿＿＿（待填）', anchor: '00-管理/选题/选题确认书.md' },
      { text: '学号：＿＿＿（待填）', anchor: '00-管理/选题/选题确认书.md' },
      { text: '指导教师：＿＿＿（待填）', anchor: '01-开题/任务书.md' },
      { text: '答辩日期：＿＿＿＿（待填）', anchor: '00-管理/时间线.md' },
    ],
    note: '开场 20 秒：自报课题与姓名，一句话说清课题做什么；占位符（姓名/学号/导师/日期）必须由本人替换。',
  }),
  () => ({
    kind: 'toc',
    title: '目录',
    bullets: [
      { text: '背景与现状', anchor: '01-开题/开题报告.md' },
      { text: '设计、实现与测试', anchor: '06-论文/大纲.md' },
      { text: '结论与创新点', anchor: '06-论文/章节/07-总结与展望.md' },
    ],
    note: '10 秒带过，只报章节顺序，不展开；顺序必须与后面的讲述顺序一致。',
  }),
]

const FIXED_TAIL: readonly ((input: SegmentInput) => SkeletonEntry)[] = [
  ({ materials }) => ({
    kind: 'innovation',
    title: '创新点与不足',
    bullets: [
      { text: '自评创新点：结合绪论本文工作', anchor: '06-论文/章节/01-绪论.md#1.3' },
      { text: '不足 1：诚实说明边界', anchor: '06-论文/章节/07-总结与展望.md#7.2' },
      { text: '不足 2 与改进方向', anchor: '06-论文/章节/07-总结与展望.md#7.2' },
      ...(materials.techChoices.length > 0
        ? [{ text: `选型证据：${materials.techChoices[0]!.item}`, anchor: '03-设计/技术选型论证.md' }]
        : []),
    ],
    note: '创新点讲"相对现有方案的差异"，不足讲 2 条真实的并各给改进方向；不要用"时间有限"敷衍。',
  }),
  () => ({
    kind: 'thanks',
    title: '致谢',
    bullets: [
      { text: '感谢指导教师与评阅老师', anchor: '06-论文/章节/07-总结与展望.md#致谢' },
      { text: '感谢实验室/同学的支持', anchor: '06-论文/章节/07-总结与展望.md#致谢' },
      { text: '请各位老师批评指正', anchor: '06-论文/章节/07-总结与展望.md#致谢' },
    ],
    note: '固定收尾话术："我的汇报到此结束，谢谢各位老师，请批评指正。"留出提问时间。',
  }),
]

const SEGMENT_BY_ID: Readonly<Record<SegmentId, Segment>> = {
  background: SEGMENTS[0]!,
  status: SEGMENTS[1]!,
  route: SEGMENTS[2]!,
  design: SEGMENTS[3]!,
  impl: SEGMENTS[4]!,
  test: SEGMENTS[5]!,
  conclusion: SEGMENTS[6]!,
}

/** 段落页数分配结果。 */
export interface Composition {
  readonly ids: readonly SegmentId[]
  readonly parts: Readonly<Record<SegmentId, number>>
}

/**
 * 按目标页数分配各段落页数：固定头（封面、目录）与固定尾（创新点、致谢）各 1 页，
 * 中间的 7 个段落至少各 1 页，多出来的页数按可展开顺序补 2 页以上的段落。
 */
export function composeSlides(targetPages: number): Composition {
  const fixed = 4
  const middleIds: SegmentId[] = SEGMENTS.map(s => s.id)
  const pages = clamp(Math.round(targetPages), fixed + middleIds.length, 20)
  const expandable = SEGMENTS.filter(s => s.expandable).map(s => s.id)
  const counts = new Map<SegmentId, number>()
  for (const id of middleIds) counts.set(id, 1)
  let remaining = pages - fixed - middleIds.length
  let cursor = 0
  while (remaining > 0) {
    const id = expandable[cursor % expandable.length]!
    counts.set(id, (counts.get(id) ?? 1) + 1)
    remaining -= 1
    cursor += 1
  }
  const ids: SegmentId[] = []
  const parts: Record<SegmentId, number> = { background: 0, status: 0, route: 0, design: 0, impl: 0, test: 0, conclusion: 0 }
  const seen = new Map<SegmentId, number>()
  for (const id of middleIds) {
    const count = counts.get(id) ?? 1
    for (let i = 0; i < count; i += 1) {
      const n = seen.get(id) ?? 0
      parts[id] = n
      seen.set(id, n + 1)
      ids.push(id)
    }
  }
  return { ids, parts }
}

function toSlide(index: number, spec: SkeletonEntry): PlannedSlide {
  const bullets: PlanBullet[] = spec.bullets.map(b => {
    const cut = truncateBullet(b.text)
    const base: PlanBullet = {
      text: cut.text,
      truncated: cut.truncated,
      ...(b.anchor !== undefined ? { anchor: b.anchor } : {}),
    }
    return cut.truncated && cut.original !== undefined ? { ...base, original: cut.original } : base
  })
  return {
    index,
    kind: spec.kind,
    title: truncateTitle(spec.title),
    bullets,
    note: spec.note,
  }
}

/** 听众档位对应的时长与页数参数。 */
export function audienceProfile(audience: Audience): {
  readonly label: string
  readonly secondsMin: number
  readonly secondsMax: number
  readonly pages: readonly [number, number]
  readonly defaultPages: number
  readonly advice: string
} {
  if (audience === 'master') {
    return {
      label: '硕士',
      secondsMin: 45,
      secondsMax: 70,
      pages: MASTER_PAGES,
      defaultPages: 13,
      advice: '硕士答辩讲述更细：实现与测试各给 2 页以上，预计时长 12-16 分钟，按学校通知的汇报时长裁剪。',
    }
  }
  return {
    label: '本科',
    secondsMin: SECONDS_PER_SLIDE_MIN,
    secondsMax: SECONDS_PER_SLIDE_MAX,
    pages: UNDERGRAD_PAGES,
    defaultPages: 11,
    advice: '本科答辩按 8-12 分钟准备：每页 40-60 秒，超过 12 分钟要删页，不要靠语速硬撑。',
  }
}

/** {@link buildSlidePlan} 的输入。 */
export interface BuildSlidePlanInput {
  /** 课题标题（通常来自进度台账）。 */
  readonly title: string
  readonly audience: Audience
  /** 目标页数（会被夹到骨架允许的区间，并在结果里报告）。 */
  readonly targetPages: number
  /** `07-答辩/答辩素材.md` 原文；缺失时传 undefined。 */
  readonly defenseMaterials?: string
  /** 素材缺失时的回退章节（真实文件内容）。 */
  readonly chapterFiles?: readonly { readonly name: string; readonly text: string }[]
}

/**
 * 生成幻灯片计划（纯函数；不读磁盘、不编造素材）。
 *
 * 步骤：解析素材 → 取骨架 → 按目标页数补齐段落 → 填素材 → 截断要点 → 估时。
 */
export function buildSlidePlan(input: BuildSlidePlanInput): SlidePlan {
  const audience = input.audience
  const profile = audienceProfile(audience)
  const parsed = input.defenseMaterials !== undefined && input.defenseMaterials.trim() !== ''
    ? parseDefenseMaterials(input.defenseMaterials)
    : undefined
  const source: MaterialSource = parsed !== undefined
    && (parsed.chapters.length > 0 || parsed.techChoices.length > 0 || parsed.decisions.length > 0)
    ? 'defense-materials'
    : 'chapters'
  const chapterDigests = source === 'chapters' ? parseChapterFallback(input.chapterFiles ?? []) : (parsed?.chapters ?? [])
  const materials: DefenseMaterials = parsed !== undefined
    ? { ...parsed, chapters: chapterDigests }
    : {
        title: input.title,
        chapters: chapterDigests,
        techChoices: [],
        decisions: [],
        testCases: 0,
        resultFiles: [],
      }

  const rawTitle = parsed !== undefined && parsed.title !== '' ? parsed.title : input.title
  const warnings: string[] = []
  if (rawTitle === '' || rawTitle === '本科毕业论文（设计）') {
    warnings.push('课题标题为默认值——请在进度台账或幻灯片计划里替换为你的真实课题名。')
  }

  const requested = Number.isFinite(input.targetPages) ? Math.round(input.targetPages) : profile.defaultPages
  const [minPages, maxPages] = profile.pages
  const composition = composeSlides(clamp(requested, minPages, maxPages))
  const pageAdjustment = requested !== composition.ids.length + 4
    ? `目标 ${requested} 页超出${profile.label}答辩骨架允许的 ${minPages}-${maxPages} 页，已按 ${composition.ids.length + 4} 页生成。`
    : undefined

  const slides: PlannedSlide[] = []
  for (const head of FIXED_HEAD) slides.push(toSlide(slides.length + 1, head({ planTitle: rawTitle })))
  const totals = new Map<SegmentId, number>()
  for (const id of composition.ids) totals.set(id, (totals.get(id) ?? 0) + 1)
  for (const id of composition.ids) {
    const segment = SEGMENT_BY_ID[id]
    const spec = segment.page({
      planTitle: rawTitle,
      materials,
      source,
      part: composition.parts[id],
      total: totals.get(id) ?? 1,
    })
    slides.push(toSlide(slides.length + 1, spec))
  }
  for (const tail of FIXED_TAIL) {
    slides.push(toSlide(slides.length + 1, tail({ planTitle: rawTitle, materials, source, part: 0, total: 1 })))
  }

  const note = source === 'defense-materials'
    ? undefined
    : (parsed === undefined
        ? '素材未生成，建议先跑 thesis_defense：当前计划由论文章节标题回退生成，未编造任何系统细节。'
        : '答辩素材里没有可用的章节/选型/决定记录，建议先跑 thesis_defense 重新生成素材。')

  const pages = slides.length
  const minMinutes = Math.max(1, Math.round((pages * profile.secondsMin) / 60))
  const maxMinutes = Math.max(1, Math.round((pages * profile.secondsMax) / 60))

  const plan: SlidePlan = {
    title: rawTitle,
    audience,
    pages,
    slides,
    estimate: {
      minMinutes,
      maxMinutes,
      secondsPerSlideMin: profile.secondsMin,
      secondsPerSlideMax: profile.secondsMax,
      advice: profile.advice,
    },
    ...(pageAdjustment !== undefined ? { pageAdjustment } : {}),
    source,
    warnings,
  }
  return note !== undefined ? { ...plan, note } : plan
}

// ---------------------------------------------------------------------------
// 素材装载（唯一读盘入口）
// ---------------------------------------------------------------------------

/** 读盘结果：台账标题、素材原文、回退章节。 */
export interface OutlineInputs {
  readonly ledgerTitle: string
  readonly defenseMaterials?: string
  readonly chapterFiles: readonly { readonly name: string; readonly text: string }[]
}

async function readOptional(fs: FileSystem, absPath: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    return await fs.readText(await fs.resolve(absPath, { signal }), signal)
  } catch {
    return undefined
  }
}

/** 从进度台账提取课题标题（与 thesis_build/thesis_defense 的口径一致）。 */
export function titleFromLedger(ledger: string | undefined): string {
  if (ledger === undefined) return '本科毕业论文（设计）'
  for (const raw of ledger.split(/\r?\n/)) {
    const line = raw.trim()
    const matched = /^(?:-\s*)?(?:title|课题)\s*[:：]\s*(.+)$/i.exec(line)
    if (matched?.[1] !== undefined && matched[1].trim() !== '') return matched[1].trim()
  }
  return '本科毕业论文（设计）'
}

/** 装载生成幻灯计划所需的全部输入（素材 → 回退章节 → 台账标题）。 */
export async function loadOutlineInputs(fs: FileSystem, root: string, signal?: AbortSignal): Promise<OutlineInputs> {
  const ledgerTitle = titleFromLedger(await readOptional(fs, nodePath.join(root, '00-管理/进度台账.md'), signal))
  const defenseMaterials = await readOptional(fs, nodePath.join(root, '07-答辩/答辩素材.md'), signal)
  const chapterFiles: { name: string; text: string }[] = []
  if (defenseMaterials === undefined || defenseMaterials.trim() === '') {
    const dir = nodePath.join(root, '06-论文/章节')
    try {
      const entries = await fs.listDir(await fs.resolve(dir, { signal }), signal)
      for (const entry of entries) {
        if (entry.isDirectory || !entry.name.endsWith('.md')) continue
        const text = await readOptional(fs, nodePath.join(dir, entry.name), signal)
        if (text !== undefined) chapterFiles.push({ name: entry.name, text })
      }
    } catch {
      // 章节目录不存在：回退路径无内容，计划里如实标注。
    }
  }
  return {
    ledgerTitle,
    ...(defenseMaterials !== undefined ? { defenseMaterials } : {}),
    chapterFiles,
  }
}

/** 计划的人类可读摘要（工具返回值用，有界）。 */
export function summarizePlan(plan: SlidePlan): string[] {
  const lines: string[] = []
  lines.push(`- 实际页数：${plan.pages} 页（听众：${audienceProfile(plan.audience).label}）`)
  lines.push(`- 预计时长：${plan.estimate.minMinutes}-${plan.estimate.maxMinutes} 分钟（每页 ${plan.estimate.secondsPerSlideMin}-${plan.estimate.secondsPerSlideMax} 秒）`)
  lines.push(`- 素材来源：${plan.source === 'defense-materials' ? '07-答辩/答辩素材.md' : '06-论文/章节/*.md（回退）'}`)
  if (plan.note !== undefined) lines.push(`- 提示：${plan.note}`)
  if (plan.pageAdjustment !== undefined) lines.push(`- 页数调整：${plan.pageAdjustment}`)
  for (const warning of plan.warnings) lines.push(`- 注意：${warning}`)
  const truncated = [...new Set(plan.slides.filter(s => s.bullets.some(b => b.truncated)).map(s => s.index))]
  if (truncated.length > 0) lines.push(`- 超长要点已截断并标记：第 ${truncated.join('、')} 页`)
  return lines
}
