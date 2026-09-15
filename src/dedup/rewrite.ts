/**
 * 降重的「改写处方」：确定性规则，不调用 LLM。
 *
 * 对每个高风险段落产出结构化处方：
 * 1. **必须保留的要素** —— 数字与单位、引用标记 `[n]`、代码标识符、双引号术语。
 *    降重绝不能靠改数据、改术语、删引用来实现。
 * 2. **可替换的句式** —— 逐句给出候选结构：拆短长句、主被动转换、并列改递进、
 *    删除冗余连接词、调整语序（保留全部要素、只动结构）。
 * 3. **引用化位置** —— 来源是文献笔记/他人段落时，提示改为直接引用 + 标注。
 * 4. **禁止事项** —— 不得为了降重改动数据与结论，不得改动专业术语与引文。
 *
 * @module dsh-thesis/dedup
 */

import type { CorpusSpan, RiskItem } from './similarity.ts'

/** 必须原样保留的要素。 */
export interface ProtectedElement {
  /** `number` 数字与单位 | `citation` 引用标记 | `code` 代码标识符 | `term` 双引号术语。 */
  readonly kind: 'number' | 'citation' | 'code' | 'term'
  readonly text: string
  /** 在归一化段文本中的起始下标。 */
  readonly index: number
}

/** 一条句式改写候选。 */
export interface RewriteSuggestion {
  /** `split` 拆短 | `voice` 转换 | `connector` 改递进 | `delete` 删冗余 | `reorder` 调整语序。 */
  readonly kind: 'split' | 'voice' | 'connector' | 'delete' | 'reorder'
  readonly target: string
  readonly detail: string
}

/** 引用化建议（命中来源不是自己原创时）。 */
export interface CitationSuggestion {
  readonly needed: boolean
  readonly source: string
  readonly detail: string
}

/** 命中片段（原文坐标，供用户定位）。 */
export interface MatchExcerpt {
  readonly length: number
  readonly text: string
  readonly lineStart: number
  readonly lineEnd: number
}

export interface RewritePlan {
  /** 章节/文件标识。 */
  readonly chapter: string
  readonly lineStart: number
  readonly lineEnd: number
  readonly score: number
  readonly source: string
  /** 命中片段（原文坐标）。 */
  readonly matches: readonly MatchExcerpt[]
  /** 必须保留的要素（去重后按出现顺序）。 */
  readonly mustKeep: readonly ProtectedElement[]
  /** 可替换的句式。 */
  readonly suggestions: readonly RewriteSuggestion[]
  readonly citation: CitationSuggestion
  /** 禁止事项（含数据/结论红线）。 */
  readonly forbidden: readonly string[]
  /** 改写锚点：先换结构再换词，改完用 thesis_originality verify 复测。 */
  readonly anchors: readonly string[]
}

const FORBIDDEN: readonly string[] = [
  '不得为了降重改动任何数据、单位、图号、表号或测试结果（改动即学术不端）',
  '不得为了降重改动结论、删减论证或删除必要引用',
  '不得改动专业术语、专有名词与文献引文（引文另有规范，不能"改写"）',
  '不得删除引用标注 [n] 或把引文改写成自己的话而不标注',
  '不得用同义词回填（同义词替换不改变指纹重合，且会破坏术语一致性）',
]

const ANCHORS: readonly string[] = [
  '先改结构（拆句/换语序/换主被动），再改措辞——结构变了，指标才会真正下降',
  '改写后跑 thesis_originality verify，用 baseline 对比降幅，别凭感觉判断',
  '命中片段若来自文献笔记，改为"直接引用 + [n] 标注"比改写更安全',
]

function pushUnique(list: ProtectedElement[], element: ProtectedElement): void {
  if (list.some(item => item.text === element.text)) return
  list.push(element)
}

/** 识别必须保留的要素（数字/单位、引用标记、代码标识符、双引号术语）。 */
export function protectedElements(text: string): ProtectedElement[] {
  const found: ProtectedElement[] = []
  for (const m of text.matchAll(/[0-9]+(?:\.[0-9]+)*(?:%|‰|[万亿千百]?[年月日个次条项分秒人台例篇倍种]|[a-zA-Z]{1,8})?/g)) {
    pushUnique(found, { kind: 'number', text: m[0], index: m.index ?? 0 })
  }
  for (const m of text.matchAll(/\[\d+(?:\s*[-,]\s*\d+)*\]/g)) {
    pushUnique(found, { kind: 'citation', text: m[0], index: m.index ?? 0 })
  }
  for (const m of text.matchAll(/`[^`\n]{1,40}`/g)) {
    pushUnique(found, { kind: 'code', text: m[0], index: m.index ?? 0 })
  }
  for (const m of text.matchAll(/\b[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+\b/g)) {
    pushUnique(found, { kind: 'code', text: m[0], index: m.index ?? 0 })
  }
  for (const m of text.matchAll(/[a-z]+[A-Z][A-Za-z0-9]*/g)) {
    pushUnique(found, { kind: 'code', text: m[0], index: m.index ?? 0 })
  }
  for (const m of text.matchAll(/[A-Za-z][A-Za-z0-9]*\(\)/g)) {
    pushUnique(found, { kind: 'code', text: m[0], index: m.index ?? 0 })
  }
  for (const m of text.matchAll(/[""]([^""\n]{2,30})[""]/g)) {
    pushUnique(found, { kind: 'term', text: m[1]!, index: (m.index ?? 0) + 1 })
  }
  return found.sort((a, b) => a.index - b.index)
}

const SPLIT_MARKERS = ['；', ';', '，而', ',而', '，同时', '，并且', '，进而', '，从而']

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

/** 逐句生成候选句式（确定性；不调用 LLM，也不做同义词替换）。 */
export function sentenceSuggestions(rawText: string): RewriteSuggestion[] {
  const suggestions: RewriteSuggestion[] = []
  const sentences = rawText
    .split(/(?<=[。！？!?])|(?<=\.\s)/)
    .map(s => s.trim())
    .filter(s => s.length > 0)
  for (const sentence of sentences) {
    const marker = SPLIT_MARKERS.find(m => sentence.includes(m))
    if (sentence.length >= 40 || marker !== undefined) {
      suggestions.push({
        kind: 'split',
        target: clip(sentence, 40),
        detail: '拆成 2-3 句：每句只留一个主谓结构，中间用"因此/其中/在此基础上"衔接，句间加主语。',
      })
    }
    const passive = /被[^，。；]{1,20}(用于|采用|实现|提出|设计|完成)/.exec(sentence)
    if (passive !== null) {
      suggestions.push({
        kind: 'voice',
        target: passive[0],
        detail: '主被动转换：把施动者提到句首（"本文采用…"/"系统通过…实现…"），去掉"被"字结构。',
      })
    }
    const parallel = /不仅[^，。]{1,40}而且/.exec(sentence) ?? /既[^，。]{1,40}又/.exec(sentence)
    if (parallel !== null) {
      suggestions.push({
        kind: 'connector',
        target: parallel[0],
        detail: '并列改递进：改成"在…基础上进一步…"，让两个分句体现推进关系而不是简单罗列。',
      })
    }
    if (marker !== undefined) {
      suggestions.push({
        kind: 'connector',
        target: marker,
        detail: '长并列常靠连接词堆叠；改成短句 + 分号或句号，删掉可推断的连接词。',
      })
    }
    for (const filler of ['综上所述', '总而言之', '值得注意的是', '众所周知', '不难发现', '显而易见', '在当今', '近年来']) {
      if (sentence.includes(filler)) {
        suggestions.push({
          kind: 'delete',
          target: filler,
          detail: '删除该冗余连接词；套话既不加分也不降重，只会被判定为模板化表达。',
        })
      }
    }
    const lead = /^(基于|针对|随着|通过)[^，。]{1,24}[，,]/.exec(sentence)
    if (lead !== null) {
      suggestions.push({
        kind: 'reorder',
        target: lead[0],
        detail: '调整语序：把结论或对象提到句首（"…（对象）在…（条件）下表现为…"），避免全段同一开头。',
      })
    }
  }
  if (suggestions.length === 0) {
    suggestions.push({
      kind: 'reorder',
      target: clip(rawText, 40),
      detail: '本段无长句/被动/套话特征，按"结论先行 + 证据后置"重排语序，并补一个具体锚点（数字/图表/案例）。',
    })
  }
  return suggestions
}

function isExternal(label: string): boolean {
  return /文献|笔记|refs\.bib|\.bib|paper|arxiv|知网|万方|维普|他人|references/i.test(label)
}

function citationAdvice(label: string): CitationSuggestion {
  if (isExternal(label)) {
    return {
      needed: true,
      source: label,
      detail: `命中来源「${label}」属于文献笔记/外部材料：应改为直接引用（引号 + 逐字照录）并在句末标注 [n]，而不是把别人的话改写成自己的表述。`,
    }
  }
  return {
    needed: false,
    source: label,
    detail: `命中来源「${label}」在本文内部：正常做法是改写这段并交叉引用（"如第 x 节所述"）或删除重复表述，不必再加引用标注。`,
  }
}

function toExcerpts(spans: readonly CorpusSpan[]): MatchExcerpt[] {
  return spans.map(span => ({
    length: span.length,
    text: span.text,
    lineStart: span.lineStart,
    lineEnd: span.lineEnd,
  }))
}

/** 单个高风险段落 → 改写处方。 */
export function planRewrite(risk: RiskItem): RewritePlan {
  const rawText = risk.segment.raw
  const citation = citationAdvice(risk.best.label)
  return {
    chapter: risk.segment.chapter,
    lineStart: risk.segment.lineStart,
    lineEnd: risk.segment.lineEnd,
    score: risk.best.score,
    source: risk.best.label,
    matches: toExcerpts(risk.best.spans),
    mustKeep: protectedElements(rawText),
    suggestions: sentenceSuggestions(rawText),
    citation,
    forbidden: [...FORBIDDEN],
    anchors: [...ANCHORS],
  }
}

/** 处方对象 → Markdown 片段。 */
export function renderPlan(plan: RewritePlan): string {
  const lines: string[] = []
  lines.push(`### ${plan.chapter} 第 ${plan.lineStart}-${plan.lineEnd} 行（相似度 ${(plan.score * 100).toFixed(1)}%）`)
  lines.push('')
  lines.push(`- 命中来源：${plan.source}`)
  if (plan.matches.length === 0) {
    lines.push('- 命中片段：（碎片化重合，无连续长片段）')
  } else {
    lines.push(`- 命中片段（连续重合 ${plan.matches[0]!.length} 字起）：`)
    for (const match of plan.matches) {
      lines.push(`  - 第 ${match.lineStart}-${match.lineEnd} 行：${clip(match.text.replace(/\n/g, ' '), 120)}`)
    }
  }
  lines.push('')
  if (plan.mustKeep.length === 0) {
    lines.push('**必须保留**：本段未检出数字/引用/代码标识符；专业术语与专有名词仍须原样保留。')
  } else {
    lines.push('**必须保留（改写时不得改动）**：')
    for (const element of plan.mustKeep) {
      const label = element.kind === 'number' ? '数字/单位' : element.kind === 'citation' ? '引用标记' : element.kind === 'code' ? '代码标识符' : '术语'
      lines.push(`- [${label}] \`${element.text}\``)
    }
  }
  lines.push('')
  lines.push('**可替换的句式**：')
  for (const suggestion of plan.suggestions) {
    lines.push(`- （${suggestionKindLabel(suggestion.kind)}）\`${suggestion.target}\` → ${suggestion.detail}`)
  }
  lines.push('')
  lines.push(`**引用化位置**：${plan.citation.needed ? '需要' : '不需要'}。${plan.citation.detail}`)
  lines.push('')
  lines.push('**禁止事项**：')
  for (const item of plan.forbidden) lines.push(`- ${item}`)
  lines.push('')
  lines.push('**改写锚点**：')
  for (const item of plan.anchors) lines.push(`- ${item}`)
  lines.push('')
  return lines.join('\n')
}

function suggestionKindLabel(kind: RewriteSuggestion['kind']): string {
  if (kind === 'split') return '拆短长句'
  if (kind === 'voice') return '主被动转换'
  if (kind === 'connector') return '并列改递进/删连接词'
  if (kind === 'delete') return '删冗余连接词'
  return '调整语序'
}

/** 批量渲染处方（报告用）。 */
export function renderPlans(plans: readonly RewritePlan[]): string[] {
  return plans.map(plan => renderPlan(plan))
}
