/**
 * 章节确定性评审（thesis_review 的核心）。
 *
 * 六个可执行检查，全部基于真实文件内容，不做任何"感觉式"判断：
 * 1. 字数：正文 CJK 字符数 vs 该章目标区间
 * 2. 大纲：模板要求的全部小节标题是否齐全
 * 3. 引用：文中引用编号是否都能对应 refs.bib 中的条目（顺序编码制）
 * 4. 图表：图/表编号章号正确、序号从 1 连续
 * 5. 未完成标记：待补/TODO/尖括号占位等残留
 * 6. G2 清单：章节模板内嵌验收清单的勾选状态
 *
 * 语义质量（论证是否充分、逻辑是否连贯）由 AI 依据 thesis-writing 技能评审，
 * 本工具只负责"可被机器证明"的部分——报告与清单一起构成 G2 验收依据。
 */

import { parseBibKeys } from './bibtex.ts'
import type { ChapterMeta } from './layout.ts'

export interface ReviewFinding {
  readonly check: string
  readonly ok: boolean
  readonly detail: string
}

export interface ReviewInput {
  readonly chapterText: string
  readonly bibText: string
  readonly meta: ChapterMeta
  readonly chapterNo: number
}

// ---------------------------------------------------------------------------
// 各检查项
// ---------------------------------------------------------------------------

function cjkCount(text: string): number {
  return (text.match(/[\u4e00-\u9fff]/g) ?? []).length
}

function parseWordRange(meta: ChapterMeta): { min: number; max: number } | undefined {
  const m = /(\d+)\s*[-–]\s*(\d+)/.exec(meta.words)
  if (m === null) return undefined
  return { min: Number(m[1]), max: Number(m[2]) }
}

function checkWordCount(text: string, meta: ChapterMeta): ReviewFinding {
  const range = parseWordRange(meta)
  if (range === undefined) return { check: '字数', ok: true, detail: `目标区间未定义（${meta.words}）` }
  const count = cjkCount(text)
  if (count < range.min) {
    return { check: '字数', ok: false, detail: `${count} 字，低于目标 ${meta.words}（差 ${range.min - count} 字）` }
  }
  if (count > range.max) {
    return { check: '字数', ok: false, detail: `${count} 字，超过目标 ${meta.words}（超 ${count - range.max} 字）` }
  }
  return { check: '字数', ok: true, detail: `${count} 字，符合目标 ${meta.words}` }
}

/** 从标题行提取小节编号（如 "## 1.1 研究背景" → "1.1"）。 */
function headingNumbers(text: string): Set<string> {
  const numbers = new Set<string>()
  for (const line of text.split('\n')) {
    const m = /^#{1,6}\s+(\d+(?:\.\d+)*)\s/.exec(line)
    if (m?.[1] !== undefined) numbers.add(m[1])
  }
  return numbers
}

function checkOutline(text: string, meta: ChapterMeta): ReviewFinding {
  const found = headingNumbers(text)
  const missing: string[] = []
  for (const item of meta.outline) {
    const m = /^(\d+(?:\.\d+)*)\s/.exec(item)
    const number = m?.[1]
    if (number !== undefined && !found.has(number)) missing.push(item)
  }
  if (missing.length === 0) {
    return { check: '大纲', ok: true, detail: `${meta.outline.length} 个小节全部齐全` }
  }
  return { check: '大纲', ok: false, detail: `缺少小节：${missing.join('、')}` }
}

/** 解析正文引用标注 [1]、[2-4]、[1,3,5]，返回所有引用编号。 */
function citedNumbers(text: string): number[] {
  const numbers = new Set<number>()
  for (const m of text.matchAll(/\[(\d+(?:[-,，]\d+)*)\]/g)) {
    const token = m[1]!
    for (const part of token.split(/[,，]/)) {
      const range = /^(\d+)-(\d+)$/.exec(part)
      if (range !== null) {
        const from = Number(range[1])
        const to = Number(range[2])
        for (let n = Math.min(from, to); n <= Math.max(from, to); n += 1) numbers.add(n)
      } else if (/^\d+$/.test(part)) {
        numbers.add(Number(part))
      }
    }
  }
  return [...numbers].sort((a, b) => a - b)
}

function checkCitations(text: string, bibText: string, chapterNo: number): ReviewFinding {
  const cited = citedNumbers(text)
  const bibCount = parseBibKeys(bibText).size
  if (cited.length === 0) {
    // 绪论（1）与相关技术（2）必须引用；其余章允许无引用。
    if (chapterNo === 1 || chapterNo === 2) {
      return { check: '引用', ok: false, detail: `正文无任何引用标注。绪论与相关技术章必须引用文献（当前 refs.bib 共 ${bibCount} 条）` }
    }
    return { check: '引用', ok: true, detail: `本章无引用（第 ${chapterNo} 章允许；绪论与相关技术章才强制要求）` }
  }
  const max = cited[cited.length - 1]!
  if (max > bibCount) {
    return { check: '引用', ok: false, detail: `引用编号 [${max}] 超出文献库（refs.bib 共 ${bibCount} 条）` }
  }
  return { check: '引用', ok: true, detail: `引用编号 ${cited.join('、')} 共 ${cited.length} 个，均在 refs.bib（${bibCount} 条）范围内` }
}

/** 图/表编号：第 n 章的编号必须是 n-k，k 从 1 连续，且不得出现其它章编号。 */
export function checkNumberedObjects(text: string, chapterNo: number, kind: '图' | '表'): ReviewFinding {
  const pattern = kind === '图' ? /图\s*(\d+)[-–](\d+)/g : /表\s*(\d+)[-–](\d+)/g
  const numbers = new Set<number>()
  const wrongChapter = new Set<string>()
  for (const m of text.matchAll(pattern)) {
    const chapter = Number(m[1])
    if (chapter === chapterNo) {
      numbers.add(Number(m[2]))
    } else {
      wrongChapter.add(`${kind} ${m[1]}-${m[2]}`)
    }
  }
  const problems: string[] = []
  const list = [...numbers].sort((a, b) => a - b)
  if (list.length === 0 && wrongChapter.size === 0) {
    return { check: `${kind}编号`, ok: true, detail: `本章无${kind}（如后续添加，编号须为 ${kind} ${chapterNo}-1 起连续）` }
  }
  if (list.length > 0) {
    const max = list[list.length - 1]!
    for (let n = 1; n <= max; n += 1) {
      if (!numbers.has(n)) {
        problems.push(`编号不连续：有 ${kind} ${chapterNo}-${max} 但缺 ${kind} ${chapterNo}-${n}`)
        break
      }
    }
  }
  if (wrongChapter.size > 0) {
    problems.push(`出现其它章的编号：${[...wrongChapter].join('、')}（本章为第 ${chapterNo} 章）`)
  }
  if (problems.length > 0) return { check: `${kind}编号`, ok: false, detail: problems.join('；') }
  return { check: `${kind}编号`, ok: true, detail: `${list.map(n => `${kind} ${chapterNo}-${n}`).join('、')} 连续且章号正确` }
}

const PLACEHOLDER_RE = /（待补）|待补充|待写|TODO|TBD|FIXME|XXX|此处省略|<[^>]{2,}>|［待[^］]*］/g

function checkPlaceholders(text: string): ReviewFinding {
  const hits: string[] = []
  for (const m of text.matchAll(PLACEHOLDER_RE)) hits.push(m[0])
  if (hits.length === 0) return { check: '未完成标记', ok: true, detail: '无待补/TODO 等残留' }
  const samples = [...new Set(hits)].slice(0, 5).join('、')
  return { check: '未完成标记', ok: false, detail: `${hits.length} 处残留：${samples}${hits.length > 5 ? ' 等' : ''}。完稿前必须清理` }
}

function checkG2Checklist(text: string, meta: ChapterMeta): ReviewFinding {
  const section = /##\s*本章 G2 验收清单([\s\S]*?)(?=\n## |\n# |$)/.exec(text)
  const body = section?.[1] ?? ''
  const unchecked = (body.match(/^\s*- \[ \]/gm) ?? []).length
  const checked = (body.match(/^\s*- \[x\]/gm) ?? []).length
  const total = meta.checklist.length
  if (body.trim() === '') {
    return { check: 'G2 清单', ok: false, detail: `章节缺少"本章 G2 验收清单"一节（模板要求 ${total} 项）` }
  }
  if (unchecked > 0) {
    return { check: 'G2 清单', ok: false, detail: `${unchecked}/${total} 项未勾选（已勾选 ${checked} 项）。逐项完成后勾选，再进入用户人工验收` }
  }
  return { check: 'G2 清单', ok: true, detail: `${total} 项全部勾选` }
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

export interface ReviewReport {
  readonly chapter: string
  readonly chapterNo: number
  readonly title: string
  readonly findings: readonly ReviewFinding[]
  readonly allOk: boolean
}

export function reviewChapter(input: ReviewInput): ReviewReport {
  const findings: ReviewFinding[] = [
    checkWordCount(input.chapterText, input.meta),
    checkOutline(input.chapterText, input.meta),
    checkCitations(input.chapterText, input.bibText, input.chapterNo),
    checkNumberedObjects(input.chapterText, input.chapterNo, '图'),
    checkNumberedObjects(input.chapterText, input.chapterNo, '表'),
    checkPlaceholders(input.chapterText),
    checkG2Checklist(input.chapterText, input.meta),
  ]
  return {
    chapter: input.meta.file,
    chapterNo: input.chapterNo,
    title: input.meta.title,
    findings,
    allOk: findings.every(f => f.ok),
  }
}

export function renderReviewReport(report: ReviewReport): string {
  const lines: string[] = []
  lines.push(`# 章节评审报告：${report.chapter}（第 ${report.chapterNo} 章 ${report.title}）`)
  lines.push('')
  for (const f of report.findings) {
    lines.push(`- ${f.ok ? '✓' : '✗'} ${f.check}：${f.detail}`)
  }
  const failed = report.findings.filter(f => !f.ok).length
  lines.push('')
  if (failed === 0) {
    lines.push('结论：全部确定性检查通过。接下来由 AI 依据 thesis-writing 技能做语义评审（论证/逻辑/去 AI 味），然后进入 G2 人工验收。')
  } else {
    lines.push(`结论：${failed} 项检查未通过，先处理上述问题再复评（thesis_review 复跑）。处理完毕后进入 G2 人工验收：用户阅读→修改→签字，然后用 thesis_progress gate G2 pass。`)
  }
  return lines.join('\n')
}
