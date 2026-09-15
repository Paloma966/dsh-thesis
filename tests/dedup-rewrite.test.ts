/**
 * 改写处方的测试：必须保留的要素（数字/单位/引用标记/代码标识符/术语）、
 * 句式候选（拆句/主被动/连接词/语序）、引用化建议与禁止事项。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { segmentsFromText } from '../src/dedup/normalize.ts'
import { scan, type RiskItem } from '../src/dedup/similarity.ts'
import { planRewrite, protectedElements, renderPlan, sentenceSuggestions } from '../src/dedup/rewrite.ts'

const SOURCE = '本文提出的注意力机制通过计算查询向量与键向量的相似度来确定每个位置应该关注的信息，'
  + '并在 8 个数据集上完成了 1200 次实验，平均准确率提升 3.5 个百分点，'
  + '响应时间控制在 35 毫秒以内，相关结论与文献 [7] 一致，代码入口为 `user_service.py` 中的 buildIndex 函数。'

function riskOf(text: string, label = '02-文献/笔记/attention.md'): RiskItem {
  const { segments } = segmentsFromText(text, { file: '01-绪论.md', chapter: '01-绪论', minChars: 20 })
  assert.ok(segments.length > 0)
  const result = scan({
    segments,
    corpus: [{ id: label, label, text: text.replace('本文提出', '已有工作提出') }],
    options: { shingle: 4, threshold: 0.2, minRun: 8 },
  })
  assert.equal(result.items.length, 1, '样本应命中一次')
  return result.items[0]!
}

test('dedup 处方：必须保留的要素包含数字、单位、引用标记与代码标识符', () => {
  const elements = protectedElements(SOURCE)
  const texts = elements.map(element => element.text)
  assert.ok(texts.includes('8'), `数字 8 缺失：${texts.join('/')}`)
  assert.ok(texts.includes('1200'), `数字 1200 缺失：${texts.join('/')}`)
  assert.ok(texts.includes('3.5'), `数字 3.5 缺失：${texts.join('/')}`)
  assert.ok(texts.includes('35'), `数字 35 缺失：${texts.join('/')}`)
  // 单位（毫秒）与数字在归一化文本中相邻 → 必须原样保留的数值+单位对完整可回溯。
  for (const unit of ['毫秒', '数据集', '个百分点']) {
    const at = SOURCE.indexOf(unit)
    assert.ok(at > 0, `样本缺少单位 ${unit}`)
    const covered = elements.some(element => element.index >= at - 8 && element.index < at)
    assert.ok(covered, `单位 ${unit} 前的数字未被识别为必须保留：${texts.join('/')}`)
  }
  assert.ok(texts.includes('[7]'), `引用标记缺失：${texts.join('/')}`)
  assert.ok(texts.some(text => text.includes('user_service.py')), `代码标识符缺失：${texts.join('/')}`)
  assert.ok(texts.some(text => text.includes('buildIndex')), `代码标识符缺失：${texts.join('/')}`)
  const kinds = new Set(elements.map(element => element.kind))
  assert.ok(kinds.has('number') && kinds.has('citation') && kinds.has('code'))
})

test('dedup 处方：planRewrite 产出结构化处方（保留项 + 句式 + 引用化 + 禁止事项 + 锚点）', () => {
  const plan = planRewrite(riskOf(SOURCE))
  assert.equal(plan.chapter, '01-绪论')
  assert.ok(plan.lineStart >= 1 && plan.lineEnd >= plan.lineStart)
  assert.ok(plan.score > 0.2)
  assert.equal(plan.source, '02-文献/笔记/attention.md')
  assert.ok(plan.mustKeep.length >= 5)
  assert.ok(plan.suggestions.length >= 1)
  assert.equal(plan.citation.needed, true)
  assert.ok(plan.citation.detail.includes('直接引用'))
  assert.ok(plan.forbidden.length >= 3)
  assert.ok(plan.forbidden.some(item => item.includes('数据')))
  assert.ok(plan.forbidden.some(item => item.includes('结论')))
  assert.ok(plan.anchors.some(item => item.includes('verify')))
})

test('dedup 处方：命中来源在本文内部时不要求加引用标注', () => {
  const plan = planRewrite(riskOf(SOURCE, '05-实验测试/结果/性能测试.md'))
  assert.equal(plan.citation.needed, false)
  assert.ok(plan.citation.detail.includes('内部'))
})

test('dedup 处方：长句拆短、被动转主动、并列改递进、删套话都能被识别', () => {
  const suggestions = sentenceSuggestions('综上所述，本文系统被用于实现数据采集，不仅完成了采集而且完成了可视化分析，'
    + '并且在 8 个数据集上进行了测试，平均响应时间下降 42%，这与文献 [3] 的结论一致。')
  const kinds = new Set(suggestions.map(item => item.kind))
  assert.ok(kinds.has('delete'), '应识别套话"综上所述"')
  assert.ok(kinds.has('voice'), '应识别被动句"被用于"')
  assert.ok(kinds.has('connector'), '应识别并列连接词')
  assert.ok(kinds.has('split'), '长句应建议拆短')
  for (const suggestion of suggestions) {
    assert.ok(suggestion.target.length > 0)
    assert.ok(suggestion.detail.length > 0)
  }
})

test('dedup 处方：无特征段落也给出至少一条改写锚点建议', () => {
  const suggestions = sentenceSuggestions('系统包括用户模块与订单模块。')
  assert.equal(suggestions.length, 1)
  assert.equal(suggestions[0]!.kind, 'reorder')
})

test('dedup 处方：renderPlan 的 Markdown 含分值、行号、保留项与禁止事项', () => {
  const plan = planRewrite(riskOf(SOURCE))
  const markdown = renderPlan(plan)
  assert.ok(markdown.includes('第 1-1 行'))
  assert.ok(markdown.includes('命中来源'))
  assert.ok(markdown.includes('必须保留'))
  assert.ok(markdown.includes('`1200`'))
  assert.ok(markdown.includes('`[7]`'))
  assert.ok(markdown.includes('可替换的句式'))
  assert.ok(markdown.includes('引用化位置'))
  assert.ok(markdown.includes('禁止事项'))
  assert.ok(markdown.includes('改写锚点'))
})
