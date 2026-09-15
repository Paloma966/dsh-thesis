/**
 * 归一化与段落切分的测试：全角/半角、Markdown 标记、CRLF、偏移映射、段落过滤。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isSkippedLine,
  lineAt,
  normalizeText,
  offsetsFor,
  segmentsFromText,
  sliceRaw,
  toHalfWidth,
} from '../src/dedup/normalize.ts'

test('dedup 归一化：全角转半角、中文按字、拉丁按词、去标点空白', () => {
  const doc = normalizeText('ＡＢＣ 测试\n  全角（括号），Latin Word!')
  assert.equal(doc.text, 'abc测试全角括号latinword')
  // 中文逐字成 token，拉丁整词成一个 token。
  assert.deepEqual(doc.tokens.map(t => t.text), ['abc', '测', '试', '全', '角', '括', '号', 'latin', 'word'])
})

test('dedup 归一化：每个字符都能映射回原文偏移（Markdown 标记与标点被跳过）', () => {
  const text = '**研究**背景'
  const doc = normalizeText(text)
  assert.equal(doc.text, '研究背景')
  // 归一化第 0 个字符"研"来自原文下标 2（** 之后）。
  assert.equal(doc.chars[0]!.offset, 2)
  const mapped = offsetsFor(doc, 0, 2)
  assert.deepEqual(mapped, { start: 2, end: 4 })
  assert.equal(sliceRaw(text, mapped!.start, mapped!.end), '研究')
})

test('dedup 归一化：CRLF 统一为 LF，行号只按 \\n 计', () => {
  const half = toHalfWidth('第一行\r\n第二行\r\n')
  assert.equal(half, '第一行\n第二行\n')
  assert.equal(lineAt(half, 0), 1)
  assert.equal(lineAt(half, 4), 2)
})

test('dedup 归一化：Latin 大小写归一，词内保留数字与下划线（标识符可区分）', () => {
  const doc = normalizeText('HTTP_Server 与 APIv2 接口')
  assert.equal(doc.text, 'http_server与apiv2接口')
})

test('dedup 归一化：标点被丢弃，但偏移仍逐字对应原文', () => {
  const text = '系统在 35 毫秒内完成 1200 次查询，平均响应时间下降 42%。'
  const doc = normalizeText(text)
  assert.equal(doc.text, '系统在35毫秒内完成1200次查询平均响应时间下降42')
  // 字符级映射：归一化第 i 个字符的偏移就是它在原文里的下标。
  for (let i = 0; i < doc.chars.length; i += 1) {
    assert.equal(text[doc.chars[i]!.offset], doc.chars[i]!.ch, `第 ${i} 个字符映射错误`)
  }
  // 中间片段（跳过空格与标点）仍能精确取回。
  const from = doc.text.indexOf('1200')
  const mapped = offsetsFor(doc, from, from + 4)
  assert.deepEqual(mapped, { start: 13, end: 17 })
  assert.equal(sliceRaw(text, mapped!.start, mapped!.end), '1200')
})

test('dedup 切分：跳过标题行/代码块/公式行/表格/参考文献/短段落', () => {
  const text = [
    '# 第 1 章 绪论',                       // 标题：跳过
    '',
    '这是第一段正文，用来验证段落切分是否会把标题与代码块排除在比对之外，长度必须超过最小阈值。',
    '',
    '```ts',
    'const x = 1',
    '```',
    '',
    '$$ E = mc^2 $$',
    '',
    '| 列A | 列B |',
    '| --- | --- |',
    '',
    '这是一段很短的话。',                    // 短于 minChars：跳过
    '',
    '## 参考文献',                            // 之后的条目不算正文
    '',
    '[1] 张三. 论文题目. 学报, 2020.',
    '[2] 李四. 另一篇. 会议, 2021.',
  ].join('\n')
  const { segments, skippedShort } = segmentsFromText(text, { file: '01-绪论.md', chapter: '01-绪论', minChars: 30 })
  assert.equal(segments.length, 1)
  assert.equal(skippedShort, 1)
  assert.equal(segments[0]!.lineStart, 3)
  assert.equal(segments[0]!.lineEnd, 3)
  assert.ok(segments[0]!.raw.startsWith('这是第一段正文'))
})

test('dedup 切分：连续非空行合并为一段，空行断开', () => {
  const text = [
    '第一段第一行，内容足够长以便通过最小长度阈值检查，用于合并测试。',
    '第一段第二行，继续同一段落。',
    '',
    '第二段第一行，也是独立的一段，长度同样需要超过设定的最小阈值。',
  ].join('\n')
  const { segments } = segmentsFromText(text, { file: 'a.md', minChars: 20 })
  assert.equal(segments.length, 2)
  assert.equal(segments[0]!.lineStart, 1)
  assert.equal(segments[0]!.lineEnd, 2)
  assert.equal(segments[1]!.lineStart, 4)
  assert.equal(segments[1]!.lineEnd, 4)
})

test('dedup 行级过滤：结构行判定覆盖标题/代码/公式/引用/列表', () => {
  assert.equal(isSkippedLine('## 2.1 相关技术'), true)
  assert.equal(isSkippedLine('```python'), true)
  assert.equal(isSkippedLine('$$ x = y $$'), true)
  assert.equal(isSkippedLine('> 写作要求：基于真实素材'), true)
  assert.equal(isSkippedLine('- 提纲第一条'), true)
  assert.equal(isSkippedLine('[3] 王五. 文献. 2022.'), true)
  assert.equal(isSkippedLine('系统采用前后端分离架构，前端使用 Vue 框架。'), false)
})

test('dedup 切分：段落偏移能在原文件文本上切出一致片段', () => {
  const text = '开头一句无关的话。\n\n系统在 35 毫秒内完成 1200 次查询，平均响应时间下降 42%。'
  const { segments } = segmentsFromText(text, { file: 'a.md', minChars: 10 })
  assert.equal(segments.length, 1)
  const segment = segments[0]!
  assert.equal(segment.lineStart, 3)
  assert.equal(segment.lineEnd, 3)
  const doc = segment.doc
  const mapped = offsetsFor(doc, 0, doc.chars.length)
  assert.ok(mapped !== null)
  // 片段从段落原文切出；首尾标点不参与归一化，故区间不含句末句号。
  // 注意 `segment.text` 已做过全角→半角，因此逗号/句号显示为半角。
  assert.equal(sliceRaw(segment.text, mapped!.start, mapped!.end), '系统在 35 毫秒内完成 1200 次查询,平均响应时间下降 42')
  const lines = segment.text.split('\n')
  assert.equal(lines.length, 1)
  assert.equal(lines[0], '系统在 35 毫秒内完成 1200 次查询,平均响应时间下降 42%.')
  // 段落自身的起始行可直接用于报告展示。
  assert.equal(segment.lineStart, 3)
})
