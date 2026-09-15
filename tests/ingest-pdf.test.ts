/**
 * PDF 尽力而为抽取测试：能抽的（未压缩/FlateDecode/转义/ToUnicode）必须抽对，
 * 抽不了的（加密/扫描版/损坏/非 PDF）必须**如实说明原因**，绝不编造内容。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bytesToLatin1, extractContentText, extractPdf, parseObjects, parseToUnicode, readPdfText } from '../src/ingest/pdf.ts'
import { buildPdf } from './ingest-fixtures.ts'

const OPTIONS = { maxChars: 100000 }

test('pdf：未压缩内容流能抽出 Tj 文本', () => {
  const fixture = buildPdf({ pages: [['Hello PDF'], ['Second page']] })
  const result = extractPdf(fixture.bytes, OPTIONS)
  assert.equal(result.ok, true)
  assert.equal(result.text, 'Hello PDF\n\nSecond page')
  assert.match(result.note ?? '', /共 2 页/)
})

test('pdf：FlateDecode 内容流走 inflateRawSync', () => {
  const fixture = buildPdf({ pages: [['压缩流文本']], deflate: true })
  const result = extractPdf(fixture.bytes, OPTIONS)
  assert.equal(result.ok, true)
  assert.equal(result.text, '压缩流文本')
})

test('pdf：字符串转义（\\( \\) \\\\ 与八进制）正确还原', () => {
  const fixture = buildPdf({
    pages: [[]],
    contentLines: ['BT /F1 12 Tf 10 10 Td (a \\(b\\) c \\\\ d \\101) Tj ET'],
  })
  const result = extractPdf(fixture.bytes, OPTIONS)
  assert.equal(result.ok, true)
  assert.equal(result.text, 'a (b) c \\ d A')
})

test('pdf：TJ 数组按字距调整补词间空格', () => {
  const fixture = buildPdf({
    pages: [[]],
    contentLines: ["BT /F1 12 Tf [(Hel) -10 (lo)] TJ [(-300) (world)] TJ ET"],
  })
  const result = extractPdf(fixture.bytes, OPTIONS)
  assert.equal(result.ok, true)
  assert.match(result.text, /Hello world/)
})

test('pdf：带 ToUnicode CMap 时按映射还原（含中文码位）', () => {
  const fixture = buildPdf({
    pages: [[]],
    toUnicode: true,
    // Identity-H 是双字节编码：'A' 写成 <0041>，中文写成 <4E2D>
    contentLines: ['BT /F1 12 Tf <0041> Tj <4E2D> Tj ET'],
  })
  const result = extractPdf(fixture.bytes, OPTIONS)
  assert.equal(result.ok, true)
  assert.equal(result.text, 'A中')
})

test('pdf：内容是 UTF-8 字节但字体无 ToUnicode 时如实还原并标注', () => {
  // 构造 UTF-8 字节的字符串字面量：\345\216\213 …（"压缩流文本"）
  const escaped = Array.from(new TextEncoder().encode('压缩流文本')).map(byte => `\\${byte.toString(8).padStart(3, '0')}`).join('')
  const fixture = buildPdf({ pages: [[]], contentLines: [`BT /F1 12 Tf (${escaped}) Tj ET`] })
  const result = extractPdf(fixture.bytes, OPTIONS)
  assert.equal(result.ok, true)
  assert.equal(result.text, '压缩流文本')
  assert.match(result.note ?? '', /UTF-8/)
  assert.equal(result.lowConfidence, true)
})

test('pdf：引号操作符（\' 与 "）显示字符串', () => {
  const fixture = buildPdf({
    pages: [[]],
    contentLines: ["BT /F1 12 Tf (first) ' (second) \" ET"],
  })
  const result = extractPdf(fixture.bytes, OPTIONS)
  assert.equal(result.ok, true)
  assert.match(result.text, /first/)
  assert.match(result.text, /second/)
})

test('pdf：加密 PDF 返回 ok:false 且提示另存为', () => {
  const fixture = buildPdf({ pages: [['secret']], encrypted: true })
  const result = extractPdf(fixture.bytes, OPTIONS)
  assert.equal(result.ok, false)
  assert.match(result.note ?? '', /加密/)
  assert.match(result.note ?? '', /另存为|正文/)
})

test('pdf：没有文字对象（扫描版式）返回 ok:false 且给出下一步', () => {
  const fixture = buildPdf({ pages: [[]], contentLines: ['q 612 0 0 792 0 0 cm /Im0 Do Q'], image: true })
  const result = extractPdf(fixture.bytes, OPTIONS)
  assert.equal(result.ok, false)
  assert.match(result.note ?? '', /没有文字|只有图片|扫描/)
})

test('pdf：非 PDF 字节报"文件头不是 %PDF-"', () => {
  const result = extractPdf(new TextEncoder().encode('这不是 PDF'), OPTIONS)
  assert.equal(result.ok, false)
  assert.match(result.note ?? '', /不是 PDF 文件/)
})

test('pdf：损坏/空文件不抛异常，返回可读原因', () => {
  const empty = extractPdf(new Uint8Array(0), OPTIONS)
  assert.equal(empty.ok, false)
  assert.match(empty.note ?? '', /空/)

  const broken = extractPdf(new TextEncoder().encode('%PDF-1.4\n%%EOF\n'), OPTIONS)
  assert.equal(broken.ok, false)
  assert.ok((broken.note ?? '').length > 10)
})

test('pdf：文本量偏少但页数多时标 lowConfidence', () => {
  const fixture = buildPdf({ pages: [['a'], ['b'], ['c'], ['d']] })
  const result = extractPdf(fixture.bytes, OPTIONS)
  assert.equal(result.ok, true)
  assert.equal(result.lowConfidence, true)
  assert.match(result.note ?? '', /抽取率异常低|页/)
})

test('pdf：maxChars 截断', () => {
  const fixture = buildPdf({ pages: [['X'.repeat(500)]] })
  const result = extractPdf(fixture.bytes, { maxChars: 60 })
  assert.equal(result.truncated, true)
  assert.ok(result.text.length <= 60)
})

test('pdf：内部工具函数（对象解析 / CMap / 内容流）', () => {
  const bytes = new TextEncoder().encode('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n2 0 obj\n<< /Length 5 >>\nstream\nabcde\nendstream\nendobj\n%%EOF')
  const objects = parseObjects(bytesToLatin1(bytes))
  assert.equal(objects.length, 2)
  assert.equal(objects[1]?.stream?.length, 5)
  assert.equal(objects[1]?.kind, 'stream')

  const cmap = parseToUnicode('1 begincodespacerange\n<00> <ff>\nendcodespacerange\n1 beginbfchar\n<41> <0041>\nendbfchar\n2 beginbfrange\n<50> <51> <0058>\nendbfrange')
  assert.equal(cmap.codeBytes, 1)
  assert.equal(cmap.map.get(0x41), 'A')
  assert.equal(cmap.map.get(0x50), 'X')
  assert.equal(cmap.map.get(0x51), 'Y')

  const extracted = extractContentText('BT /F1 12 Tf (hi) Tj ET', new Map())
  assert.equal(extracted.text, 'hi')
  assert.equal(extracted.strings, 1)
})

test('pdf：readPdfText 直接报告页数与提示', () => {
  const fixture = buildPdf({ pages: [['x'], ['y']] })
  const read = readPdfText(fixture.bytes)
  assert.equal(read.pages, 2)
  assert.ok(read.text.includes('x'))
})
