/**
 * 相似度度量的测试：containment / jaccard / longestRun / 命中偏移、
 * 改写后得分下降、无关文本接近 0、段落过滤、倒排剪枝等价性。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeText, segmentsFromText } from '../src/dedup/normalize.ts'
import {
  buildIndex,
  compareText,
  fingerprintOf,
  fingerprintSegment,
  hashShingle,
  intersectionSize,
  scan,
} from '../src/dedup/similarity.ts'

const OPTIONS = { shingle: 4, minRun: 8, maxSpans: 5 }

const ORIGINAL = '本文提出的注意力机制通过计算查询向量与键向量的相似度来确定每个位置应该关注的信息，并在 8 个数据集上完成了 1200 次实验，平均准确率提升 3.5 个百分点。'

// 改写：同义替换 + 语序调整（保留全部数字与术语）。
const REWRITTEN = '该机制先度量查询与键之间的相似程度，据此决定各位置应当获得多少关注；'
  + '我们在 8 个公开语料上跑了 1200 轮实验，准确率平均提高 3.5 个百分点，'
  + '与同类方法相比，性能损失可以忽略不计。'

const UNRELATED = '数据库连接池负责复用物理连接，索引重建任务安排在每日凌晨的低峰期，'
  + '运维通过慢查询日志定位性能瓶颈，并据此调整参数。'

function segmentOf(text: string, chapter: string): ReturnType<typeof segmentsFromText>['segments'][number] {
  const { segments } = segmentsFromText(text, { file: `${chapter}.md`, chapter, minChars: 20 })
  assert.ok(segments.length > 0, `样本段落未通过切分：${chapter}`)
  return segments[0]!
}

test('dedup 相似度：完全相同段落 containment ≈ 1，jaccard ≈ 1，longestRun = 全段长度', () => {
  const result = compareText(ORIGINAL, ORIGINAL, OPTIONS)
  assert.ok(result.containment > 0.999, `containment=${result.containment}`)
  assert.equal(result.jaccard, 1)
  const doc = normalizeText(ORIGINAL)
  assert.equal(result.longestRun, doc.chars.length)
  assert.equal(result.spans[0]!.aStart, 0)
  assert.equal(result.spans[0]!.bStart, 0)
})

test('dedup 相似度：命中片段偏移能切出正确原文（longestRun 定位正确）', () => {
  const common = '查询向量与键向量的相似度'
  const a = `前文无关内容甲乙丙丁，${common}，后文也无关戊己庚辛。`
  const b = `另一段完全不同的开头壬癸子丑，${common}，结尾也是别的话寅卯辰巳。`
  const result = compareText(a, b, { shingle: 4, minRun: 8, maxSpans: 3 })
  assert.ok(result.longestRun >= common.length, `longestRun=${result.longestRun}`)
  const span = result.spans[0]!
  assert.equal(span.length, result.longestRun)
  // A 侧的片段文本必须能在原文 A 中按偏移取出。
  const docA = normalizeText(a)
  const raw = a.slice(docA.chars[span.aStart]!.offset, docA.chars[span.aEnd - 1]!.offset + 1)
  assert.ok(raw.includes(common), `片段文本=${raw}`)
  const docB = normalizeText(b)
  const rawB = b.slice(docB.chars[span.bStart]!.offset, docB.chars[span.bEnd - 1]!.offset + 1)
  assert.equal(rawB, raw)
})

test('dedup 相似度：改写后得分显著下降，无关文本接近 0', () => {
  const before = compareText(ORIGINAL, ORIGINAL, OPTIONS)
  const after = compareText(REWRITTEN, ORIGINAL, OPTIONS)
  const unrelated = compareText(UNRELATED, ORIGINAL, OPTIONS)
  assert.ok(before.containment > 0.99, `before=${before.containment}`)
  assert.ok(after.containment < 0.5, `after=${after.containment}`)
  assert.ok(after.containment < before.containment * 0.5, `before=${before.containment} after=${after.containment}`)
  assert.ok(after.jaccard < before.jaccard)
  assert.ok(unrelated.containment < 0.05, `unrelated=${unrelated.containment}`)
  assert.ok(unrelated.longestRun < 8, `unrelated longestRun=${unrelated.longestRun}`)
})

test('dedup 相似度：指纹可复现（同输入同哈希、同集合大小）', () => {
  const a = fingerprintOf(ORIGINAL, 4)
  const b = fingerprintOf(ORIGINAL, 4)
  assert.deepEqual([...a.shingles].sort((x, y) => x - y), [...b.shingles].sort((x, y) => x - y))
  assert.equal(hashShingle('查询向量'), hashShingle('查询向量'))
  assert.notEqual(hashShingle('查询向量'), hashShingle('查询键向'))
})

test('dedup 扫描：命中来源、得分、片段偏移与文本都在同一段内', () => {
  const segment = segmentOf(`${ORIGINAL}`, '01-绪论')
  const noteTail = '该笔记还记录了实验环境的配置、数据集划分方式、超参数搜索范围与失败案例分析，'
    + '并给出了与本文不同的三处结论，供写作时对照参考，避免直接照搬表述。'
  const result = scan({
    segments: [segment],
    corpus: [{ id: '02-文献/笔记/attention.md', label: '02-文献/笔记/attention.md', text: `相关工作的笔记开头。\n\n${ORIGINAL}\n\n${noteTail}` }],
    options: { shingle: 4, threshold: 0.3, minRun: 8 },
  })
  assert.equal(result.items.length, 1)
  assert.equal(result.high, 1)
  const item = result.items[0]!
  assert.equal(item.best.id, '02-文献/笔记/attention.md')
  assert.ok(item.best.score > 0.99, `score=${item.best.score}`)
  assert.ok(item.best.spans.length >= 1)
  const span = item.best.spans[0]!
  assert.equal(span.lineStart, segment.lineStart)
  assert.equal(span.lineEnd, segment.lineEnd)
  assert.ok(ORIGINAL.includes(span.text) || span.text.length > 0)
  assert.ok(span.length >= 8)
})

test('dedup 扫描：自比屏蔽（正文互查时不会把自己判成抄袭自己）', () => {
  const text = `# 第 1 章 绪论\n\n${ORIGINAL}\n`
  const { segments } = segmentsFromText(text, { file: '01-绪论.md', chapter: '01-绪论', minChars: 20 })
  const result = scan({
    segments,
    corpus: [{ id: '01-绪论.md', label: '01-绪论（正文互查）', text }],
    options: { shingle: 4, threshold: 0.3, minRun: 8 },
  })
  assert.equal(result.items.length, 0)
  assert.equal(result.high, 0)
  assert.equal(result.paragraphCount, segments.length)
})

test('dedup 扫描：段落与其所在整章比较不算重复（按文件自比屏蔽）', () => {
  const chapter = `# 第 1 章 绪论\n\n${ORIGINAL}\n\n${UNRELATED}\n`
  const { segments } = segmentsFromText(chapter, { file: '01-绪论.md', chapter: '01-绪论', minChars: 20 })
  assert.ok(segments.length >= 2)
  // 每段都被整章包含（containment=1），但语料 id 与本段 file 相同 → 必须按自比跳过。
  const wholeChapter = segments.map(segment => segment.raw).join('\n\n')
  const result = scan({
    segments,
    corpus: [{ id: '01-绪论.md', label: '01-绪论（正文互查）', text: wholeChapter }],
    options: { shingle: 4, threshold: 0.3, minRun: 8 },
  })
  assert.equal(result.items.length, 0, `意外命中：${result.items.map(item => item.best.id).join('/')}`)
  assert.equal(result.high, 0)
  assert.equal(result.paragraphCount, segments.length)
})

test('dedup 扫描：同一章的副本改个文件名就不再被当作自比（跨章/跨文件重复仍能发现）', () => {
  const chapter = `# 第 1 章 绪论\n\n${ORIGINAL}\n\n${UNRELATED}\n`
  const { segments } = segmentsFromText(chapter, { file: '06-论文/章节/01-绪论.md', chapter: '01-绪论', minChars: 20 })
  const wholeChapter = segments.map(segment => segment.raw).join('\n\n')
  const result = scan({
    segments,
    corpus: [{ id: '02-文献/笔记/他人摘录.md', label: '02-文献/笔记/他人摘录.md', text: wholeChapter }],
    options: { shingle: 4, threshold: 0.3, minRun: 8 },
  })
  assert.equal(result.items.length, segments.length)
  assert.equal(result.high, segments.length)
})

test('dedup 扫描：候选剪枝（倒排索引）与朴素两两比对结果完全一致（~50 段小语料）', () => {
  const corpusTexts: { id: string; label: string; text: string }[] = []
  for (let c = 0; c < 10; c += 1) {
    const parts: string[] = [`# 语料 ${c}`, '']
    for (let p = 0; p < 6; p += 1) {
      parts.push(`语料第${c}组第${p}段讨论了主题${(c * 7 + p) % 13}的若干细节，编号 ${c * 100 + p}，结论是模式 ${(c + p) % 5} 更稳定。`)
      parts.push('')
    }
    corpusTexts.push({ id: `corpus/${c}.md`, label: `corpus/${c}.md`, text: parts.join('\n') })
  }
  const segments = []
  for (let s = 0; s < 6; s += 1) {
    const text = `目标第${s}段讨论了主题${(s * 3) % 13}的若干细节，编号 ${s * 100 + (s % 6)}，`
      + `结论是模式 ${(s + 2) % 5} 更稳定；另外还补充了一段与语料无关的独立论述${s}。`
    const { segments: parsed } = segmentsFromText(text, { file: `target-${s}.md`, chapter: `target-${s}`, minChars: 20 })
    for (const segment of parsed) segments.push(segment)
  }
  const options = { shingle: 4, threshold: 0.3, minRun: 8 }
  const indexed = scan({ segments, corpus: corpusTexts, options, candidateMode: 'index' })
  const naive = scan({ segments, corpus: corpusTexts, options, candidateMode: 'all' })
  assert.equal(indexed.paragraphCount, naive.paragraphCount)
  assert.equal(indexed.items.length, naive.items.length, '两两比对与剪枝的命中段落数应一致')
  indexed.items.forEach((item, index) => {
    const other = naive.items[index]!
    assert.equal(item.segment.lineStart, other.segment.lineStart)
    assert.equal(item.best.id, other.best.id)
    assert.ok(Math.abs(item.best.score - other.best.score) < 1e-12)
    assert.equal(item.best.longestRun, other.best.longestRun)
    assert.equal(item.hits.length, other.hits.length)
  })
})

test('dedup 指纹：shingle 集合大小与交集符合定义（可手算校验）', () => {
  const a = fingerprintOf('abcdef', 4)
  const b = fingerprintOf('abcdef', 4)
  assert.equal(a.shingles.size, 3)
  assert.equal(intersectionSize(a.shingles, b.shingles), 3)
  const index = buildIndex([{ id: 'x', label: 'x', shingle: a, index: 0 }])
  assert.equal(index.inverted.size, 3)
  assert.deepEqual(index.inverted.get(hashShingle('abcd')), [0])
})

test('dedup 切分：标题/代码块/参考文献不产生可比对段落', () => {
  const text = [
    '# 标题不算正文',
    '',
    '## 参考文献',
    '[1] 张三. 论文. 2020.',
    '',
    '```',
    '代码块也不算正文内容，这一行足够长但仍是代码。',
    '```',
  ].join('\n')
  const { segments } = segmentsFromText(text, { file: 'x.md', minChars: 10 })
  assert.equal(segments.length, 0)
})

test('dedup 指纹：段落实体与指纹段一致（fingerprintSegment 复用归一化结果）', () => {
  const segment = segmentOf(ORIGINAL, '01-绪论')
  const printed = fingerprintSegment(segment, 4)
  assert.equal(printed.chars, segment.doc.chars.length)
  assert.equal(printed.text, segment.doc.text)
})
