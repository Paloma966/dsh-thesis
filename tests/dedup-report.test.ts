/**
 * 报告渲染与复测的测试：分级、行号、估算口径文字、学校结果回填、baseline 解析与降幅。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { segmentsFromText } from '../src/dedup/normalize.ts'
import { scan, type ScanResult } from '../src/dedup/similarity.ts'
import {
  ALGORITHM_NOTE,
  buildReport,
  levelLabel,
  parseBaseline,
  renderReport,
  renderVerifyReport,
  verifyDelta,
  weightedRateOf,
  type ReportOptions,
} from '../src/dedup/report.ts'

const SHARED = '本文提出的注意力机制通过计算查询向量与键向量的相似度来确定每个位置应该关注的信息，并在 8 个数据集上完成了 1200 次实验。'

const MEDIUM = '数据库连接池负责复用物理连接，索引重建任务安排在每日凌晨的低峰期，运行时间约 400 毫秒。'

const OPTIONS: ReportOptions = {
  threshold: 0.3,
  shingle: 4,
  minChars: 30,
  now: new Date('2026-03-01T00:00:00.000Z'),
  corpusLabels: ['02-文献/笔记'],
}

function scanFixture(): ScanResult {
  const high = [
    '# 第 1 章 绪论',
    '',
    '这一行是完全无关的开场白，用来保证段落的第一行不是命中的目标内容。',
    '',
    SHARED,
  ].join('\n')
  const medium = [
    '# 第 2 章 相关技术',
    '',
    MEDIUM,
    '',
    '随后本文补充说明该任务在夜间执行，不会影响白天的查询请求。',
  ].join('\n')
  const highSegments = segmentsFromText(high, { file: '06-论文/章节/01-绪论.md', chapter: '01-绪论', minChars: 30 }).segments
  const mediumSegments = segmentsFromText(medium, { file: '06-论文/章节/02-相关技术.md', chapter: '02-相关技术', minChars: 30 }).segments
  const corpus = [
    {
      id: '02-文献/笔记/attention.md',
      label: '02-文献/笔记/attention.md',
      // 笔记整篇明显长于正文段落（避免触发自比屏蔽），但正文段落几乎逐字来自这篇笔记。
      text: `# 注意力机制笔记\n\n阅读时间 2026-02-01，主题为注意力机制与序列建模。\n\n${SHARED}\n\n`
        + '个人批注：该结论与本文的实验设置高度一致，写作时应核对数据集划分方式，避免直接照搬表述。\n',
    },
    {
      id: '05-实验测试/结果/性能测试.md',
      label: '05-实验测试/结果/性能测试.md',
      text: `# 性能测试结果\n\n测试环境：单机 8 核 16G，数据库 PostgreSQL 14。\n\n${MEDIUM}\n\n`
        + '补充记录：连续三次运行的结果方差小于 5%，可作为论文第 6 章的实验数据来源。\n',
    },
  ]
  return scan({
    segments: [...highSegments, ...mediumSegments],
    corpus,
    options: { shingle: 4, threshold: 0.3, minRun: 8 },
  })
}

test('dedup 报告：分级阈值正确（high ≥ threshold，medium ≥ 0.6×threshold）', () => {
  assert.equal(levelLabel('high'), '高')
  assert.equal(levelLabel('medium'), '中')
  assert.equal(levelLabel('low'), '低')
  const result = scanFixture()
  assert.ok(result.high >= 1, `high=${result.high}`)
  const report = buildReport(result, OPTIONS)
  const levels = new Set(report.risks.map(risk => risk.level))
  assert.ok(levels.has('high'), `分级缺失 high：${[...levels].join('/')}`)
  for (const risk of report.risks) {
    if (risk.level === 'high') assert.ok(risk.score >= OPTIONS.threshold)
    else assert.ok(risk.score >= OPTIONS.threshold * 0.6 && risk.score < OPTIONS.threshold)
  }
  assert.ok(report.risks.every(risk => risk.lineStart >= 1 && risk.lineEnd >= risk.lineStart))
})

test('dedup 报告：每条风险含章节/文件/行号/得分/来源/片段/处方', () => {
  const report = buildReport(scanFixture(), OPTIONS)
  assert.ok(report.risks.length >= 1)
  const risk = report.risks[0]!
  assert.equal(risk.chapter, '01-绪论')
  assert.equal(risk.file, '06-论文/章节/01-绪论.md')
  assert.ok(risk.lineStart >= 4)
  assert.ok(risk.score > OPTIONS.threshold)
  assert.equal(risk.source, '02-文献/笔记/attention.md')
  assert.ok(risk.excerpt.includes('注意力机制'))
  assert.ok(risk.excerpt.length <= 121)
  assert.ok(risk.plan.mustKeep.length >= 2, `保留项=${risk.plan.mustKeep.map(item => item.text).join('/')}`)
  assert.ok(risk.matches.length >= 1)
  assert.equal(risk.matches[0]!.lineStart, risk.lineStart)
})

test('dedup 报告：加权重复率估算口径与算法说明文字正确（明确非学校系统）', () => {
  const result = scanFixture()
  const rate = weightedRateOf(result)
  assert.ok(rate > 0 && rate < 1, `rate=${rate}`)
  // 口径：Σ(命中段字符数 × 得分) / 全部参与比对字符数。
  let weighted = 0
  for (const item of result.items) weighted += item.segment.doc.chars.length * item.best.score
  assert.ok(Math.abs(rate - weighted / result.totalChars) < 1e-12)
  const report = buildReport(result, OPTIONS)
  assert.equal(report.summary.weightedRate, rate)

  const markdown = renderReport(report, OPTIONS)
  assert.ok(markdown.includes('全文加权重复率**估算｜**：'))
  assert.ok(markdown.includes('估算口径：'))
  assert.ok(markdown.includes(ALGORITHM_NOTE))
  assert.ok(markdown.includes('不接入'))
  assert.ok(markdown.includes('绝不等同于学校检测结果'))
  assert.ok(markdown.includes('shingle=4，threshold=0.3，minChars=30'))
  assert.ok(markdown.includes('2026-03-01T00:00:00.000Z'))
  assert.ok(markdown.includes('## 5 学校检测结果（用户自行送检后回填）'))
  assert.ok(markdown.includes('检测重复率：________%'))
})

test('dedup 报告：学校检测结果可回填（百分数换算 + 差距说明）', () => {
  const report = buildReport(scanFixture(), { ...OPTIONS, detected: { rate: 12, system: '知网 PMLC', date: '2026-02-20' } })
  assert.ok(report.detected !== undefined)
  assert.ok(Math.abs(report.detected!.rate - 0.12) < 1e-12)
  assert.equal(report.detected!.system, '知网 PMLC')
  const markdown = renderReport(report, OPTIONS)
  assert.ok(markdown.includes('检测重复率：12.0%（权威口径）'))
  assert.ok(markdown.includes('知网 PMLC'))
  assert.ok(markdown.includes('差距：'))
})

test('dedup 报告：baseline 解析与复测降幅计算正确', () => {
  const baselineReport = buildReport(scanFixture(), OPTIONS)
  const baselineMarkdown = renderReport(baselineReport, OPTIONS)
  const parsed = parseBaseline(baselineMarkdown)
  assert.ok(parsed !== null)
  assert.equal(parsed!.paragraphCount, baselineReport.summary.paragraphCount)
  assert.equal(parsed!.high, baselineReport.summary.high)
  assert.equal(parsed!.medium, baselineReport.summary.medium)
  // 报告里的比率保留 1 位小数，解析回来与原始值最多差 0.0005（口径可接受）。
  assert.ok(Math.abs(parsed!.weightedRate - baselineReport.summary.weightedRate) < 0.001)
  assert.equal(parseBaseline('# 随便一份文档\n\n没有指标'), null)

  const current = {
    paragraphCount: parsed!.paragraphCount,
    matchedCount: Math.max(0, parsed!.matchedCount - 1),
    high: 0,
    medium: 0,
    weightedRate: parsed!.weightedRate * 0.2,
  }
  const delta = verifyDelta(parsed!, current)
  assert.ok(delta.rateDrop > 0)
  assert.ok(delta.rateDropRatio > 0.5)
  assert.equal(delta.highDrop, parsed!.high)
  assert.ok(delta.verdict.includes('降幅达标'))

  const currentReport = buildReport(scanFixture(), OPTIONS)
  const markdown = renderVerifyReport(delta, OPTIONS, currentReport)
  assert.ok(markdown.includes('# 降重复测报告'))
  assert.ok(markdown.includes('加权重复率降幅：'))
  assert.ok(markdown.includes('个百分点'))
  assert.ok(markdown.includes('结论：'))

  const noDrop = verifyDelta(parsed!, { ...current, weightedRate: parsed!.weightedRate, high: 1 })
  assert.ok(noDrop.verdict.includes('仍有'))
})
