/**
 * 全文综合检查（thesis_check 的核心），五项确定性检查：
 * 1. 引用双向一致：文中引用 ↔ refs.bib（顺序编码制下编号=条目顺序）
 * 2. 字数统计：每章 CJK 字数 vs 目标区间 + 全文合计
 * 3. 图/表编号：每章章号与连续性（复用 review 的检查器）
 * 4. 术语定义先于使用：缩写（ABBR）第一次出现必须在定义"全称（ABBR）"之后
 * 5. 学校模板探测：assets/学校模板 有无模板文件
 */

import { parseBibKeysOrdered } from './bibtex.ts'
import { chapterMetaFor, CHAPTER_META } from './layout.ts'
import { checkNumberedObjects, type ReviewFinding } from './review.ts'

export interface CheckChapter {
  readonly name: string
  readonly no: number
  readonly text: string
}

export interface CheckInput {
  readonly chapters: readonly CheckChapter[]
  readonly bibText: string
  readonly templateFiles: readonly string[]
}

export interface CheckSection {
  readonly id: string
  readonly title: string
  readonly ok: boolean
  readonly lines: readonly string[]
}

export interface CheckReport {
  readonly sections: readonly CheckSection[]
  readonly allOk: boolean
}

// ---------------------------------------------------------------------------
// 1. 引用双向一致
// ---------------------------------------------------------------------------

function citedNumbersIn(text: string): number[] {
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
  return [...numbers].sort((a, b) => a - b)
}

function checkCitationsGlobal(input: CheckInput): CheckSection {
  const lines: string[] = []
  const allCited = new Set<number>()
  const byChapter = new Map<string, number[]>()
  for (const chapter of input.chapters) {
    const cited = citedNumbersIn(chapter.text)
    byChapter.set(chapter.name, cited)
    for (const n of cited) allCited.add(n)
  }
  const bibKeys = parseBibKeysOrdered(input.bibText)
  const bibCount = bibKeys.length

  if (bibCount === 0 && allCited.size > 0) {
    lines.push(`✗ refs.bib 为空（0 条），但正文引用了 [${[...allCited].join('、')}]。请先经 thesis_lit_search/save 收录文献。`)
    return { id: 'citations', title: '引用双向一致', ok: false, lines }
  }
  if (bibCount === 0) {
    lines.push('⚠ 文献库为空。绪论与相关技术章写作前，请先用 thesis_lit_search 检索真实文献。')
    return { id: 'citations', title: '引用双向一致', ok: false, lines }
  }

  const citedList = [...allCited].sort((a, b) => a - b)
  const max = citedList[citedList.length - 1] ?? 0
  const outOfRange = citedList.filter(n => n > bibCount)
  if (outOfRange.length > 0) {
    lines.push(`✗ 引用编号超出文献库：${outOfRange.map(n => `[${n}]`).join('、')}（refs.bib 共 ${bibCount} 条）。`)
  }
  // 未被引用的条目（躺尸文献）
  const uncited = Array.from({ length: bibCount }, (_v, i) => i + 1).filter(n => !allCited.has(n))
  if (uncited.length > 0) {
    const keys = uncited.map(n => bibKeys[n - 1] ?? `#${n}`).join('、')
    lines.push(`⚠ 文献库中 ${uncited.length} 条从未被正文引用：${keys}。要么在正文补引，要么从 refs.bib 删除。`)
  }
  // 引用编号不连续（有 [3] 无 [2]）
  for (let n = 1; n <= max; n += 1) {
    if (!allCited.has(n)) {
      lines.push(`⚠ 引用编号不连续：缺 [${n}]（顺序编码制下编号应与文献表顺序一致）。`)
      break
    }
  }
  // 章级概览
  const chapterStats = input.chapters.map(c => `${c.name}: [${(byChapter.get(c.name) ?? []).join('、') || '无'}]`).join('；')
  lines.push(`章级引用：${chapterStats}。`)
  if (lines.length === 1) {
    lines.unshift(`✓ 正文引用与 refs.bib（${bibCount} 条）双向一致：${citedList.length === 0 ? '正文暂无引用' : `引用编号 ${citedList.join('、')} 均有对应条目`}。`)
  }
  return { id: 'citations', title: '引用双向一致', ok: outOfRange.length === 0 && bibCount > 0, lines }
}

// ---------------------------------------------------------------------------
// 2. 字数统计
// ---------------------------------------------------------------------------

function checkWordCountsGlobal(input: CheckInput): CheckSection {
  const lines: string[] = []
  let total = 0
  let problems = 0
  for (const chapter of input.chapters) {
    const located = chapterMetaFor(chapter.name)
    const count = (chapter.text.match(/[\u4e00-\u9fff]/g) ?? []).length
    total += count
    const rangeMatch = located === undefined ? null : /(\d+)\s*[-–]\s*(\d+)/.exec(located.meta.words)
    if (rangeMatch === null) {
      lines.push(`- ${chapter.name}：${count} 字（目标未知）`)
      continue
    }
    const min = Number(rangeMatch[1])
    const max = Number(rangeMatch[2])
    const ok = count >= min && count <= max
    if (!ok) problems += 1
    lines.push(`- ${chapter.name}：${count} 字 / 目标 ${min}-${max} ${ok ? '✓' : `✗（${count < min ? `差 ${min - count}` : `超 ${count - max}`}）`}`)
  }
  lines.push(`- 全文合计：${total} 字（常见本科要求 1.5-2 万，以学校文件为准）`)
  return { id: 'words', title: '字数统计', ok: problems === 0, lines }
}

// ---------------------------------------------------------------------------
// 3. 图/表编号（全文逐章）
// ---------------------------------------------------------------------------

function checkFiguresGlobal(input: CheckInput): CheckSection {
  const lines: string[] = []
  let problems = 0
  for (const chapter of input.chapters) {
    for (const kind of ['图', '表'] as const) {
      const finding: ReviewFinding = checkNumberedObjects(chapter.text, chapter.no, kind)
      if (!finding.ok) {
        problems += 1
        lines.push(`✗ ${chapter.name} ${finding.detail}`)
      }
    }
  }
  if (problems === 0) lines.push('✓ 各章图/表编号章号正确、序号连续（无图表的章不计）。')
  return { id: 'figures', title: '图/表编号', ok: problems === 0, lines }
}

// ---------------------------------------------------------------------------
// 4. 术语定义先于使用
// ---------------------------------------------------------------------------

const DEF_RE = /[\u4e00-\u9fff]{2,20}（([A-Z]{2,10})）/g

function checkTerminology(input: CheckInput): CheckSection {
  const lines: string[] = []
  // 第一遍：记录每个缩写的首次定义章。
  const definedAt = new Map<string, number>()
  input.chapters.forEach((chapter, idx) => {
    for (const m of chapter.text.matchAll(DEF_RE)) {
      const abbr = m[1]!
      if (!definedAt.has(abbr)) definedAt.set(abbr, idx)
    }
  })
  // 第二遍：在"去掉定义点"的文本里找使用，出现在定义章之前 → 违规。
  const problems = new Map<string, number>()
  input.chapters.forEach((chapter, idx) => {
    const scanText = chapter.text.replace(/（[A-Z]{2,10}）/g, '（）')
    for (const abbr of definedAt.keys()) {
      const defIdx = definedAt.get(abbr)!
      if (idx >= defIdx) continue
      const re = new RegExp(`(^|[^A-Za-z\u4e00-\u9fff])${abbr}([^A-Za-z\u4e00-\u9fff]|$)`, 'g')
      if (re.test(scanText)) {
        problems.set(abbr, defIdx)
      }
    }
  })
  if (problems.size === 0) {
    lines.push(definedAt.size === 0
      ? '✓ 未发现缩写术语定义（如使用缩写，请按"全称（缩写）"首次定义）。'
      : `✓ 已定义的 ${definedAt.size} 个缩写（${[...definedAt.keys()].join('、')}）均未在定义前使用。`)
    return { id: 'terms', title: '术语定义先于使用', ok: true, lines }
  }
  for (const [abbr, defIdx] of problems) {
    lines.push(`✗ ${abbr} 在第 ${defIdx + 1} 章才定义，但更早章节已使用。缩写首次出现时应写"全称（${abbr}）"。`)
  }
  return { id: 'terms', title: '术语定义先于使用', ok: false, lines }
}

// ---------------------------------------------------------------------------
// 5. 学校模板探测
// ---------------------------------------------------------------------------

function checkTemplate(templateFiles: readonly string[]): CheckSection {
  const hasTemplate = templateFiles.some(f => /\.(docx?|dotx?)$/i.test(f))
  if (hasTemplate) {
    return {
      id: 'template',
      title: '学校模板',
      ok: true,
      lines: [`✓ 发现学校模板文件：${templateFiles.filter(f => /\.(docx?|dotx?)$/i.test(f)).join('、')}。thesis_build 将优先使用。`],
    }
  }
  return {
    id: 'template',
    title: '学校模板',
    ok: false,
    lines: [
      '⚠ 06-论文/assets/学校模板/ 中未发现模板文件（.doc/.docx）。',
      '  thesis_build 将使用内置过渡模板并显式标注"非学校模板"。',
      '  提交前请从教务处/学院获取模板放入该目录后重建。',
    ],
  }
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

export function runGlobalCheck(input: CheckInput): CheckReport {
  const sections: CheckSection[] = [
    checkCitationsGlobal(input),
    checkWordCountsGlobal(input),
    checkFiguresGlobal(input),
    checkTerminology(input),
    checkTemplate(input.templateFiles),
  ]
  return { sections, allOk: sections.every(s => s.ok) }
}

export function renderCheckReport(report: CheckReport): string {
  const lines: string[] = []
  for (const section of report.sections) {
    lines.push(`## ${section.title}`)
    lines.push('')
    for (const line of section.lines) lines.push(line)
    lines.push('')
  }
  const failed = report.sections.filter(s => !s.ok).length
  lines.push(report.allOk
    ? '结论：全部检查通过。剩余风险项（重复率、AI 检测）请按 08-合规/自查报告.md 流程自查。'
    : `结论：${failed} 个检查项需处理。修复后重跑 thesis_check。`)
  return lines.join('\n')
}

export { CHAPTER_META }
