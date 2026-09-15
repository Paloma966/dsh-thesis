/**
 * 降重报告的渲染：分级、行号、命中来源、原文片段、处方、全文加权重复率估算，
 * 以及可回填的「学校检测结果」区块。
 *
 * 报告口径（必须与文字一起出现，不得省去）：
 * - 本地相似度是**字符串重合度估算**，算法为 shingle 指纹 + 包含率，
 *   只在用户给定的参考语料内比较，**不等于**知网/维普等系统的重复率；
 * - 本插件不接入任何收费查重系统（无账号、也不应接入）；学校结果是权威口径，
 *   用户自行送检后可把重复率回填进本报告，用于对齐两套口径的差距。
 *
 * @module dsh-thesis/dedup
 */

import type { ScanResult } from './similarity.ts'
import { planRewrite, renderPlan, type RewritePlan } from './rewrite.ts'

/** 风险分级：high（≥ threshold）| medium（≥ 0.6×threshold）| low（其余）。 */
export type RiskLevel = 'high' | 'medium' | 'low'

export interface ReportRiskItem {
  readonly level: RiskLevel
  readonly chapter: string
  readonly file: string
  readonly lineStart: number
  readonly lineEnd: number
  readonly score: number
  readonly source: string
  /** 原文片段（截断到 120 字）或命中片段（原文坐标）。 */
  readonly excerpt: string
  /** 命中片段（原文坐标，含行号）。 */
  readonly matches: readonly { readonly lineStart: number; readonly lineEnd: number; readonly text: string }[]
  /** 结构化改写处方。 */
  readonly plan: RewritePlan
  /** 该段原始文本（未截断，供结构化消费方使用）。 */
  readonly text: string
}

export interface ReportSummary {
  readonly paragraphCount: number
  readonly matchedCount: number
  readonly high: number
  readonly medium: number
  readonly low: number
  /** 唯一命中来源数。 */
  readonly sourceCount: number
  /** 全文加权重复率估计（见 {@link ReportOptions.algorithm}）。 */
  readonly weightedRate: number
}

export interface DetectedResult {
  /** 用户自行送检得到的重复率（0..1，或 0..100 的百分数，>1 视为百分数）。 */
  readonly rate: number
  /** 检测系统名称（如"知网 PMLC"），可缺省。 */
  readonly system?: string
  /** 送检/出报告日期（任意字符串，原样保留）。 */
  readonly date?: string
}

export interface ReportOptions {
  /** 判定高风险的包含率阈值。 */
  readonly threshold: number
  readonly shingle: number
  readonly minChars: number
  /** 用户自行送检的结果（可选，回填进报告）。 */
  readonly detected?: DetectedResult
  /** 查询时间（默认 `new Date()`；测试注入固定时间以保证可复现）。 */
  readonly now?: Date
  /** 本次扫描的参考语料说明（文件/目录，展示用）。 */
  readonly corpusLabels?: readonly string[]
}

export interface DedupReport {
  readonly summary: ReportSummary
  readonly risks: readonly ReportRiskItem[]
  readonly algorithm: string
  readonly generatedAt: string
  readonly detected?: DetectedResult
  readonly boundaries: readonly string[]
}

const EXCERPT_LIMIT = 120

/** 估算口径说明（单一来源，Markdown 与结构化对象共用）。 */
export const ALGORITHM_NOTE =
  '字符 4-gram shingle 指纹 + 段内包含率（containment）；只在给定参考语料内比较字符串重合，'
  + '不含语义改写、不含跨语言、不含图片/公式。因此本报告的"重复率"是**估算值**，'
  + '与知网/维普等系统的口径、语料、算法都不同，绝不等同于学校检测结果。'

/** 边界说明（写入报告，避免误用）。 */
export const BOUNDARY_NOTES: readonly string[] = [
  '本工具**不接入**知网、维普、万方等收费查重系统：既没有账号授权，也不应绕过其授权接入。',
  '本地估算只覆盖"用户给定的参考语料"——语料之外的来源不会被发现，语料越全越接近真实风险。',
  '本地估算识别不了同义替换、语序调整、翻译改写等"洗稿"手段，指标低不等于绝对安全。',
  '学校检测结果是权威口径；请把自行送检得到的重复率回填到本报告，用于对齐两套口径的差距。',
]

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`
}

/**
 * 全文加权重复率估计（口径明确、可复现）：
 * `Σ(命中段落归一化字符数 × 该段最佳命中得分) / 全文参与比对的字符总数`。
 * 分母包含**未命中段落**（按 0 计入），因此该值是保守估计（不会低报）。
 */
export function weightedRateOf(scanResult: ScanResult): number {
  if (scanResult.totalChars === 0) return 0
  let weighted = 0
  for (const item of scanResult.items) {
    weighted += item.segment.doc.chars.length * item.best.score
  }
  return weighted / scanResult.totalChars
}

function levelOf(score: number, threshold: number): RiskLevel {
  if (score >= threshold) return 'high'
  if (score >= threshold * 0.6) return 'medium'
  return 'low'
}

/** 结构化报告对象即「报告的结构化形态」。 */
export function buildReport(scanResult: ScanResult, options: ReportOptions): DedupReport {
  const sources = new Set<string>()
  const risks: ReportRiskItem[] = []
  for (const item of scanResult.items) {
    const level = levelOf(item.best.score, options.threshold)
    if (level === 'low') continue
    sources.add(item.best.label)
    const plan = planRewrite(item)
    risks.push({
      level,
      chapter: item.segment.chapter,
      file: item.segment.file,
      lineStart: item.segment.lineStart,
      lineEnd: item.segment.lineEnd,
      score: item.best.score,
      source: item.best.label,
      excerpt: clip(item.segment.raw, EXCERPT_LIMIT),
      matches: item.best.spans.map(span => ({
        lineStart: span.lineStart,
        lineEnd: span.lineEnd,
        text: clip(span.text, EXCERPT_LIMIT),
      })),
      plan,
      text: item.segment.raw,
    })
  }
  risks.sort((a, b) => b.score - a.score
    || (a.chapter < b.chapter ? -1 : a.chapter > b.chapter ? 1 : 0)
    || a.lineStart - b.lineStart)
  const report: DedupReport = {
    summary: {
      paragraphCount: scanResult.paragraphCount,
      matchedCount: scanResult.matchedCount,
      high: scanResult.high,
      medium: scanResult.medium,
      low: scanResult.low,
      sourceCount: sources.size,
      weightedRate: weightedRateOf(scanResult),
    },
    risks,
    algorithm: ALGORITHM_NOTE,
    generatedAt: (options.now ?? new Date()).toISOString(),
    boundaries: [...BOUNDARY_NOTES],
  }
  if (options.detected !== undefined) {
    return { ...report, detected: normalizeDetected(options.detected) }
  }
  return report
}

function normalizeDetected(detected: DetectedResult): DetectedResult {
  const rate = detected.rate > 1 ? detected.rate / 100 : detected.rate
  const normalized: DetectedResult = { rate: Math.max(0, Math.min(1, rate)) }
  const withSystem: DetectedResult = detected.system === undefined ? normalized : { ...normalized, system: detected.system }
  return detected.date === undefined ? withSystem : { ...withSystem, date: detected.date }
}

export function levelLabel(level: RiskLevel): string {
  if (level === 'high') return '高'
  if (level === 'medium') return '中'
  return '低'
}

/** 渲染 Markdown 报告。 */
export function renderReport(report: DedupReport, options: ReportOptions): string {
  const lines: string[] = []
  const summary = report.summary
  lines.push('# 降重报告（本地相似度度量）')
  lines.push('')
  lines.push(`> 工具：thesis_originality；生成时间：${report.generatedAt}`)
  lines.push(`> 参数：shingle=${options.shingle}，threshold=${options.threshold}，minChars=${options.minChars}`)
  if (options.corpusLabels !== undefined && options.corpusLabels.length > 0) {
    lines.push(`> 参考语料：${options.corpusLabels.join('、')}`)
  }
  lines.push('')
  lines.push('## 0 边界声明（先读这一段）')
  lines.push('')
  for (const note of report.boundaries) lines.push(`- ${note}`)
  lines.push('')
  lines.push('## 1 汇总')
  lines.push('')
  lines.push(`- 正文段落：${summary.paragraphCount} 段（跳过标题/代码块/公式行/参考文献/表格与短段落）`)
  lines.push(`- 有命中段落：${summary.matchedCount} 段；高风险 ${summary.high} 段，中风险 ${summary.medium} 段，低风险 ${summary.low} 段`)
  lines.push(`- 命中来源：${summary.sourceCount} 个`)
  lines.push(`- 全文加权重复率**估算｜**：${(summary.weightedRate * 100).toFixed(1)}%`)
  lines.push('')
  lines.push(`估算口径：${report.algorithm}`)
  lines.push('')
  lines.push('## 2 Top 风险段落')
  lines.push('')
  const top = report.risks.slice(0, 5)
  if (top.length === 0) {
    lines.push('无中/高风险段落。注意：指标低不等于绝对安全，见第 0 节边界声明。')
  } else {
    lines.push('| # | 分级 | 章节 | 行号 | 得分 | 命中来源 |')
    lines.push('|---|---|---|---|---|---|')
    top.forEach((risk, index) => {
      lines.push(`| ${index + 1} | ${levelLabel(risk.level)} | ${risk.chapter} | ${risk.lineStart}-${risk.lineEnd} | ${(risk.score * 100).toFixed(1)}% | ${risk.source} |`)
    })
    lines.push('')
    for (const risk of top) lines.push(`${risk.excerpt}`, '')
  }
  lines.push('## 3 高风险段落与改写处方')
  lines.push('')
  const high = report.risks.filter(risk => risk.level === 'high')
  if (high.length === 0) {
    lines.push('无高风险段落（≥ 阈值的段落）。中风险段落见第 4 节。')
  }
  for (const risk of high) {
    lines.push(`**原文（${risk.chapter} 第 ${risk.lineStart}-${risk.lineEnd} 行，${risk.file}）**`)
    lines.push('')
    lines.push(`> ${risk.excerpt}`)
    lines.push('')
    lines.push(renderPlan(risk.plan))
  }
  lines.push('## 4 中风险段落（逐条判断后改写）')
  lines.push('')
  const medium = report.risks.filter(risk => risk.level === 'medium')
  if (medium.length === 0) {
    lines.push('无中风险段落。')
    lines.push('')
  } else {
    lines.push('| 章节 | 行号 | 得分 | 命中来源 | 命中片段 |')
    lines.push('|---|---|---|---|---|')
    for (const risk of medium) {
      const span = risk.matches[0]
      lines.push(`| ${risk.chapter} | ${risk.lineStart}-${risk.lineEnd} | ${(risk.score * 100).toFixed(1)}% | ${risk.source} | ${span === undefined ? '（碎片化重合）' : clip(span.text, 40)} |`)
    }
    lines.push('')
  }
  lines.push('## 5 学校检测结果（用户自行送检后回填）')
  lines.push('')
  if (report.detected === undefined) {
    lines.push('- 学校/检测系统名称：________')
    lines.push('- 送检日期：________')
    lines.push('- 检测重复率：________%')
    lines.push('- 与本地估算的差距说明：________')
    lines.push('')
    lines.push('回填方式：把上述数字作为 `thesis_originality` 的 `detected_rate` 重新执行 `report`，本区块会自动填好。')
  } else {
    const detected = report.detected
    const gap = detected.rate - summary.weightedRate
    lines.push(`- 检测系统：${detected.system ?? '（未填写）'}`)
    lines.push(`- 送检日期：${detected.date ?? '（未填写）'}`)
    lines.push(`- 检测重复率：${(detected.rate * 100).toFixed(1)}%（权威口径）`)
    lines.push(`- 本地估算：${(summary.weightedRate * 100).toFixed(1)}%`)
    lines.push(`- 差距：${gap >= 0 ? '+' : ''}${(gap * 100).toFixed(1)} 个百分点（本地${gap >= 0 ? '偏低' : '偏高'}）`)
    lines.push('')
    lines.push('差距常见原因：本地语料不含学校比对库；同义改写/翻译改写无法被字符串指纹发现。'
      + '若学校结果明显更高，请扩充参考语料（把可能的来源文本放进语料目录）并重跑 scan。')
  }
  lines.push('')
  lines.push('## 6 下一步建议')
  lines.push('')
  lines.push('1. 先处理高风险段落：按处方改结构（拆句、换语序、主被动），保留全部数字与引用。')
  lines.push('2. 命中来源若为文献笔记，改为直接引用 + `[n]` 标注，不要改写成自己的话。')
  lines.push('3. 改写完成后执行 `thesis_originality` `verify`，用本次报告作 `baseline` 复测降幅。')
  lines.push('4. 送检后把真实重复率回填（`detected_rate`），对齐本地估算与学校口径。')
  lines.push('')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// 复测（verify）：从 baseline 报告解析指标并计算降幅
// ---------------------------------------------------------------------------

export interface BaselineSnapshot {
  readonly paragraphCount: number
  readonly matchedCount: number
  readonly high: number
  readonly medium: number
  readonly weightedRate: number
}

/** 从 baseline 报告（Markdown）解析出汇总指标；解析失败返回 null。 */
export function parseBaseline(markdown: string): BaselineSnapshot | null {
  const paragraph = /正文段落：(\d+)\s*段/.exec(markdown)
  const matched = /有命中段落：(\d+)\s*段/.exec(markdown)
  const high = /高风险\s*(\d+)\s*段/.exec(markdown)
  const medium = /中风险\s*(\d+)\s*段/.exec(markdown)
  const rate = /全文加权重复率\*\*估算｜\*\*：([0-9.]+)%/.exec(markdown)
  if (paragraph === null || matched === null || rate === null) return null
  return {
    paragraphCount: Number(paragraph[1]),
    matchedCount: Number(matched[1]),
    high: high === null ? 0 : Number(high[1]),
    medium: medium === null ? 0 : Number(medium[1]),
    weightedRate: Number(rate[1]) / 100,
  }
}

export interface VerifyDelta {
  readonly baseline: BaselineSnapshot
  readonly current: BaselineSnapshot
  /** 加权重复率降幅（百分点，正数表示下降）。 */
  readonly rateDrop: number
  readonly rateDropRatio: number
  readonly highDrop: number
  readonly mediumDrop: number
  readonly verdict: string
}

/** 计算复测降幅（正数 = 下降）。 */
export function verifyDelta(baseline: BaselineSnapshot, current: BaselineSnapshot): VerifyDelta {
  const rateDrop = baseline.weightedRate - current.weightedRate
  const rateDropRatio = baseline.weightedRate === 0 ? 0 : rateDrop / baseline.weightedRate
  let verdict: string
  if (current.high > 0) {
    verdict = `仍有 ${current.high} 段高风险：继续按处方改写后再次 verify。`
  } else if (rateDrop <= 0 && baseline.weightedRate > 0) {
    verdict = '加权重复率未下降：本次改写没有改变指纹重合（常见原因是只换同义词），请改结构后复测。'
  } else if (rateDropRatio >= 0.5) {
    verdict = '降幅达标（≥50%）：保持当前写法，进入下一轮自查（AI 味 + 引用检查）。'
  } else {
    verdict = '降幅有限：优先处理剩余中风险段落，或把命中来源改为直接引用。'
  }
  return {
    baseline,
    current,
    rateDrop,
    rateDropRatio,
    highDrop: baseline.high - current.high,
    mediumDrop: baseline.medium - current.medium,
    verdict,
  }
}

/** 渲染复测报告（降重报告-复测.md）。 */
export function renderVerifyReport(delta: VerifyDelta, options: ReportOptions, riskSource: DedupReport): string {
  const lines: string[] = []
  lines.push('# 降重复测报告')
  lines.push('')
  lines.push(`> 工具：thesis_originality verify；生成时间：${riskSource.generatedAt}`)
  lines.push(`> 参数：shingle=${options.shingle}，threshold=${options.threshold}，minChars=${options.minChars}`)
  lines.push('')
  lines.push('## 1 降幅')
  lines.push('')
  lines.push('| 指标 | 上次（baseline） | 本次（复测） | 变化 |')
  lines.push('|---|---|---|---|')
  lines.push(`| 正文段落 | ${delta.baseline.paragraphCount} | ${delta.current.paragraphCount} | ${signed(delta.current.paragraphCount - delta.baseline.paragraphCount)} |`)
  lines.push(`| 有命中段落 | ${delta.baseline.matchedCount} | ${delta.current.matchedCount} | ${signed(delta.current.matchedCount - delta.baseline.matchedCount)} |`)
  lines.push(`| 高风险段落 | ${delta.baseline.high} | ${delta.current.high} | ${signed(-delta.highDrop)} |`)
  lines.push(`| 中风险段落 | ${delta.baseline.medium} | ${delta.current.medium} | ${signed(-delta.mediumDrop)} |`)
  lines.push(`| 加权重复率估算 | ${(delta.baseline.weightedRate * 100).toFixed(1)}% | ${(delta.current.weightedRate * 100).toFixed(1)}% | ${signed(-delta.rateDrop * 100)} 个百分点 |`)
  lines.push('')
  lines.push(`- 加权重复率降幅：**${(delta.rateDrop * 100).toFixed(1)} 个百分点**（相对降幅 ${(delta.rateDropRatio * 100).toFixed(1)}%）`)
  lines.push(`- 结论：${delta.verdict}`)
  lines.push('')
  lines.push(`口径：${riskSource.algorithm}`)
  lines.push('')
  lines.push('## 2 仍中/高风险段落')
  lines.push('')
  const remaining = riskSource.risks.filter(risk => risk.level !== 'low')
  if (remaining.length === 0) {
    lines.push('无。')
  } else {
    lines.push('| 分级 | 章节 | 行号 | 得分 | 命中来源 |')
    lines.push('|---|---|---|---|---|')
    for (const risk of remaining) {
      lines.push(`| ${levelLabel(risk.level)} | ${risk.chapter} | ${risk.lineStart}-${risk.lineEnd} | ${(risk.score * 100).toFixed(1)}% | ${risk.source} |`)
    }
  }
  lines.push('')
  lines.push('## 3 边界声明')
  lines.push('')
  for (const note of riskSource.boundaries) lines.push(`- ${note}`)
  lines.push('')
  return lines.join('\n')
}

function signed(value: number): string {
  const rounded = Math.round(value * 10) / 10
  return `${rounded > 0 ? '+' : ''}${rounded}`
}
