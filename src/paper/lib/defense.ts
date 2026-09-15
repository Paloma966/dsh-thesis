/**
 * 答辩准备（thesis_defense 的核心）。
 *
 * 工具做"机器可提取"的部分：从论文工作区提取答辩素材（课题、章节概览、
 * 技术选型、关键决定、测试数据、git 工作量），生成：
 * - 07-答辩/答辩素材.md —— 素材摘要（答辩讲稿的事实底座）
 * - 07-答辩/预答辩问题库.md —— 六类必问问题模板 + 证据锚点
 *
 * 问题的具体化与模拟问答由 AI（结合模型能力与素材）和用户共同完成，
 * 流程见技能 thesis-defense。
 */

import { spawnSync } from 'node:child_process'

// ---------------------------------------------------------------------------
// 提取器（纯函数）
// ---------------------------------------------------------------------------

export interface ChapterDigest {
  readonly name: string
  readonly no: number
  readonly title: string
  readonly cjk: number
  readonly headings: readonly string[]
  readonly citations: number
}

export function extractHeadings(text: string): string[] {
  return text.split('\n').map(l => l.trim()).filter(l => /^#{1,3}\s/.test(l)).map(l => l.replace(/^#{1,3}\s+/, ''))
}

function countCitations(text: string): number {
  const numbers = new Set<number>()
  for (const m of text.matchAll(/\[(\d+(?:[-,，]\d+)*)\]/g)) {
    for (const part of m[1]!.split(/[,，]/)) {
      const range = /^(\d+)-(\d+)$/.exec(part)
      if (range !== null) {
        for (let n = Number(range[1]); n <= Number(range[2]); n += 1) numbers.add(n)
      } else if (/^\d+$/.test(part)) {
        numbers.add(Number(part))
      }
    }
  }
  return numbers.size
}

/** 提取技术选型表（03-设计/技术选型论证.md 的表格行）。 */
export function extractTechChoices(text: string): string[][] {
  const rows: string[][] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) continue
    const cells = trimmed.slice(1, -1).split('|').map(c => c.trim())
    const isSeparator = cells.every(c => /^:?-{2,}:?$/.test(c))
    const isHeader = cells.some(c => /选型项|选择|理由/.test(c))
    if (isSeparator || isHeader || cells.every(c => c === '')) continue
    rows.push(cells)
  }
  return rows
}

/** 提取决定日志条目标题。 */
export function extractDecisionTitles(log: string): string[] {
  const titles: string[] = []
  for (const m of log.matchAll(/^## (\d{4}-\d{2}-\d{2}) · (.+)$/gm)) {
    titles.push(`${m[1]} ${m[2]}`)
  }
  return titles
}

/** 统计测试计划用例数（TC-x 行）。 */
export function countTestCases(plan: string): number {
  return (plan.match(/^\|\s*TC-\d+/gm) ?? []).length
}

export interface GitStats {
  readonly commits: number
  readonly firstCommit?: string
  readonly lastCommit?: string
  readonly ok: boolean
  readonly error?: string
}

export type GitRunner = (root: string) => GitStats

/** 默认实现：真实运行 git（子进程）。测试注入替身。 */
export const spawnGitStats: GitRunner = (root) => {
  try {
    const count = spawnSync('git', ['-C', root, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' })
    if (count.status !== 0) return { commits: 0, ok: false, error: (count.stderr ?? '').trim() }
    const first = spawnSync('git', ['-C', root, 'log', '--reverse', '--format=%cs', 'HEAD'], { encoding: 'utf8' })
    const last = spawnSync('git', ['-C', root, 'log', '-1', '--format=%cs', 'HEAD'], { encoding: 'utf8' })
    const firstDate = (first.stdout ?? '').trim().split('\n')[0] ?? ''
    return {
      commits: Number.parseInt((count.stdout ?? '').trim(), 10) || 0,
      ...(firstDate !== '' ? { firstCommit: firstDate } : {}),
      ...((last.stdout ?? '').trim() !== '' ? { lastCommit: (last.stdout ?? '').trim() } : {}),
      ok: true,
    }
  } catch (error) {
    return { commits: 0, ok: false, error: String(error) }
  }
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

export interface DefenseInput {
  readonly title: string
  readonly chapters: readonly ChapterDigest[]
  readonly techChoices: readonly (readonly string[])[]
  readonly decisions: readonly string[]
  readonly testCases: number
  readonly resultFiles: readonly string[]
  readonly bibCount: number
  readonly git: GitStats
}

export function renderDefenseMaterials(input: DefenseInput, now: Date = new Date()): string {
  const lines: string[] = []
  lines.push('# 答辩素材')
  lines.push('')
  lines.push(`> 由 thesis_defense 自动提取；时间：${now.toISOString()}`)
  lines.push('> 这是答辩讲稿的事实底座——PPT 每页内容、问答答案都以这里的材料为准。')
  lines.push('')
  lines.push(`## 课题`)
  lines.push('')
  lines.push(input.title)
  lines.push('')
  lines.push('## 章节概览')
  lines.push('')
  for (const chapter of input.chapters) {
    lines.push(`### 第 ${chapter.no} 章 ${chapter.title}（${chapter.cjk} 字，引用 ${chapter.citations} 处）`)
    lines.push('')
    for (const heading of chapter.headings) lines.push(`- ${heading}`)
    lines.push('')
  }
  lines.push('## 技术选型（答辩必问"为什么"）')
  lines.push('')
  if (input.techChoices.length === 0) {
    lines.push('（03-设计/技术选型论证.md 尚无选型记录）')
  } else {
    for (const row of input.techChoices) lines.push(`- ${row[0] ?? '?'}：${row[1] ?? '?'}（理由：${row[2] ?? '未填'}；备选：${row[3] ?? '未填'}）`)
  }
  lines.push('')
  lines.push('## 关键决定（决定日志）')
  lines.push('')
  if (input.decisions.length === 0) lines.push('（暂无记录——答辩前把关键决策补录进决定日志）')
  for (const title of input.decisions) lines.push(`- ${title}`)
  lines.push('')
  lines.push('## 测试与数据')
  lines.push('')
  lines.push(`- 测试用例：${input.testCases} 个（05-实验测试/测试计划.md）`)
  lines.push(`- 结果文件：${input.resultFiles.length === 0 ? '（尚无真实结果文件——红线：所有答辩数据必须真实可复现）' : input.resultFiles.join('、')}`)
  lines.push('')
  lines.push('## 工作量（git）')
  lines.push('')
  if (!input.git.ok) {
    lines.push(`（git 统计不可用：${input.git.error ?? '未知原因'}）`)
  } else {
    lines.push(`- 提交：${input.git.commits} 次`)
    if (input.git.firstCommit !== undefined && input.git.lastCommit !== undefined) {
      lines.push(`- 跨度：${input.git.firstCommit} ~ ${input.git.lastCommit}`)
    }
  }
  lines.push('')
  lines.push('## 文献')
  lines.push('')
  lines.push(`refs.bib 收录 ${input.bibCount} 条（全部真实检索，审计记录见 02-文献/检索记录.md）`)
  lines.push('')
  return lines.join('\n')
}

const QUESTION_CATEGORIES: readonly { readonly name: string; readonly questions: readonly string[]; readonly anchor: string }[] = [
  {
    name: '一、实现细节（必问，老师会逐模块追问）',
    anchor: '04-实现 代码 + 05-实验测试/结果 截图',
    questions: [
      '<核心模块>具体怎么实现的？核心流程从头讲一遍。',
      '系统有哪些关键模块/数据表？数据在它们之间怎么流转？',
      '开发中遇到的最难的问题是什么？怎么定位和解决的？',
      '如果并发量/数据量扩大 10 倍，你的设计哪里会先出问题？',
    ],
  },
  {
    name: '二、技术选型（答辩高频"为什么"）',
    anchor: '03-设计/技术选型论证.md + 决定日志',
    questions: [
      '为什么选 <技术 A> 而不是 <备选 B>？',
      '<技术 A> 的缺点是什么？你在设计里怎么缓解的？',
      '如果现在换成 <备选 B>，需要改动哪些部分？',
    ],
  },
  {
    name: '三、需求与背景',
    anchor: '03-设计/需求分析.md（FR/NFR 编号）',
    questions: [
      '这个系统的需求是怎么来的？谁在用、解决什么实际问题？',
      '哪条功能需求最难实现？为什么？',
      '你的系统与现有同类系统/方案相比，差异和亮点是什么？',
    ],
  },
  {
    name: '四、工作量与过程（诚实原则）',
    anchor: 'git 提交记录 + 决定日志 + 时间线',
    questions: [
      '哪些部分是你独立完成的？开发花了多久？',
      'AI 辅助了哪些环节？你自己做的关键决策有哪些？',
      '中期检查之后方案有没有调整？为什么调整？',
    ],
  },
  {
    name: '五、数据可信',
    anchor: '05-实验测试/测试计划.md + 结果/（须可复现）',
    questions: [
      '测试数据是怎么得到的？能现场演示/复现吗？',
      '性能指标用什么工具测的？测试环境是什么？',
      '有没有失败过的用例？后来怎么处理的？',
    ],
  },
  {
    name: '六、不足与展望',
    anchor: '07-总结与展望.md + 绪论 1.3 本文主要工作',
    questions: [
      '你觉得这个系统哪里做得不够好？',
      '如果重新做一次，你会怎么改进？',
      '后续如果要继续做，方向是什么？',
    ],
  },
]

export function renderQuestionBank(title: string, now: Date = new Date()): string {
  const lines: string[] = []
  lines.push('# 预答辩问题库')
  lines.push('')
  lines.push(`> 课题：${title}；由 thesis_defense 生成骨架；时间：${now.toISOString()}`)
  lines.push('> 使用方法：AI 依据《答辩素材》把 <> 占位替换为你的系统实际名称，生成 15-20 个具体问题；')
  lines.push('> 你逐题回答并记录要点；答不上的回对应材料补学。演练流程见技能 thesis-defense。')
  lines.push('')
  for (const category of QUESTION_CATEGORIES) {
    lines.push(`## ${category.name}`)
    lines.push('')
    lines.push(`证据锚点：${category.anchor}`)
    lines.push('')
    for (const question of category.questions) {
      lines.push(`- [ ] ${question}`)
    }
    lines.push('')
  }
  lines.push('## 我的回答记录')
  lines.push('')
  lines.push('（每题回答后把要点记在这里；至少完整演练 2 轮，第 2 轮随机抽题）')
  lines.push('')
  return lines.join('\n')
}
