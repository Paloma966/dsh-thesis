/**
 * OOXML（docx/xlsx/pptx）抽取测试：实体转义、多段落、表格、共享字符串、
 * 内联字符串、空单元格对齐、幻灯片顺序、DEFLATE 容器。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decodeXmlEntities, extractDocxParagraphs, extractOoxmlParagraphs } from '../src/ingest/ooxml.ts'
import { extractDocx, readDocx } from '../src/ingest/docx.ts'
import { extractXlsx, columnIndex, parseSharedStrings, parseWorkbookRels, parseWorkbookSheets, parseStyleDateFlags, isDateFormatCode } from '../src/ingest/xlsx.ts'
import { extractPptx, slideNumber, sortSlides } from '../src/ingest/pptx.ts'
import { extractText } from '../src/ingest/index.ts'
import { buildDeflatedDocx, buildDocx, buildPptx, buildXlsx } from './ingest-fixtures.ts'

const OPTIONS = { maxChars: 100000 }

// ---------------------------------------------------------------------------
// 实体与段落切分
// ---------------------------------------------------------------------------

test('ooxml：实体解码（命名实体 + 十进制 + 十六进制）', () => {
  assert.equal(decodeXmlEntities('a&amp;b&lt;c&gt;d&quot;e&apos;f'), 'a&b<c>d"e\'f')
  assert.equal(decodeXmlEntities('&#20013;&#x6587;'), '中文')
  assert.equal(decodeXmlEntities('&unknown;'), '&unknown;', '未知实体原样保留')
})

test('ooxml：按 w:p 切段落，表格单元格用制表符分隔', () => {
  const xml = [
    '<w:p><w:r><w:t>第一段</w:t></w:r></w:p>',
    '<w:p><w:r><w:t>第二段</w:t></w:r><w:r><w:t xml:space="preserve"> 接续</w:t></w:r></w:p>',
    '<w:tbl>',
    '<w:tr><w:tc><w:p><w:r><w:t>姓名</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>成绩</w:t></w:r></w:p></w:tc></w:tr>',
    '<w:tr><w:tc><w:p><w:r><w:t>张三</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>90</w:t></w:r></w:p></w:tc></w:tr>',
    '</w:tbl>',
  ].join('')
  const paragraphs = extractDocxParagraphs(xml)
  assert.deepEqual(paragraphs, ['第一段', '第二段 接续', '姓名\t成绩', '张三\t90'])
})

test('ooxml：跳过域代码 w:instrText 与批注区间，w:tab 与 w:br 生效', () => {
  const xml = [
    '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>',
    '<w:r><w:instrText>PAGE \\* MERGEFORMAT</w:instrText></w:r>',
    '<w:r><w:fldChar w:fldCharType="end"/></w:r>',
    '<w:r><w:t>页码占位</w:t></w:r></w:p>',
    '<w:p><w:r><w:t>甲</w:t><w:tab/><w:t>乙</w:t><w:br/><w:t>丙</w:t></w:r></w:p>',
    '<w:p><w:commentRangeStart w:id="1"/><w:r><w:t>被批注的句子</w:t></w:r><w:commentRangeEnd w:id="1"/></w:p>',
  ].join('')
  const paragraphs = extractDocxParagraphs(xml)
  assert.equal(paragraphs[0], '页码占位', '域代码不应进入文本')
  assert.ok(!paragraphs.some(p => p.includes('MERGEFORMAT')))
  assert.equal(paragraphs[1], '甲\t乙\n丙')
  assert.deepEqual(paragraphs[2], undefined, '批注锚点区间被跳过')
})

test('ooxml：wantedTag 只抽指定元素（dc:title）', () => {
  const xml = '<cp:coreProperties><dc:title>我的课题</dc:title><dc:creator>张三</dc:creator></cp:coreProperties>'
  const paragraphs = extractOoxmlParagraphs(xml, {
    paragraphTags: [],
    textTags: ['title'],
    breakTags: [],
    tabTags: [],
    cellTags: [],
    rowTags: [],
    skipTags: [],
    wantedTag: 'dc:title',
  })
  assert.deepEqual(paragraphs, ['我的课题'])
})

// ---------------------------------------------------------------------------
// docx
// ---------------------------------------------------------------------------

test('docx：中文、实体转义、多段落、表格、标题', () => {
  const bytes = buildDocx({
    title: '本科毕业设计（论文）模板',
    paragraphs: ['第一章 绪论', '本文研究 A & B <对比> 问题。', '结论：有效。'],
    table: [['指标', '数值'], ['准确率', '95%']],
  })
  const content = readDocx(bytes)
  assert.equal(content.title, '本科毕业设计（论文）模板')
  assert.deepEqual(content.paragraphs, [
    '第一章 绪论',
    '本文研究 A & B <对比> 问题。',
    '结论：有效。',
    '指标\t数值',
    '准确率\t95%',
  ])
  assert.ok(content.text.includes('A & B <对比>'), '实体应还原成原字符')
})

test('docx：extractDocx 返回 ok/text/chars 与段数说明', () => {
  const bytes = buildDocx({ paragraphs: ['甲', '乙'] })
  const result = extractDocx(bytes, OPTIONS)
  assert.equal(result.ok, true)
  assert.equal(result.text, '甲\n乙')
  assert.equal(result.truncated, false)
  assert.match(result.note ?? '', /共 2 段/)
})

test('docx：空文档返回 ok:false 且原因可读', () => {
  const result = extractDocx(buildDocx({ paragraphs: [] }), OPTIONS)
  assert.equal(result.ok, false)
  assert.match(result.note ?? '', /没有任何正文文本/)
})

test('docx：把 xlsx 改名成 docx 时给出明确提示', () => {
  const bytes = buildXlsx({ sheets: [{ name: 'S1', rows: [[{ value: '1' }]] }] })
  const result = extractDocx(bytes, OPTIONS)
  assert.equal(result.ok, false)
  assert.match(result.note ?? '', /内部是 Excel 工作簿/)
})

test('docx：非 ZIP 字节报可读错误', () => {
  const result = extractDocx(new TextEncoder().encode('这不是 zip'), OPTIONS)
  assert.equal(result.ok, false)
  assert.match(result.note ?? '', /EOCD|不是 ZIP|不是有效的/)
})

test('docx：DEFLATE 容器同样可抽（method 8 全链路）', () => {
  const result = extractDocx(buildDeflatedDocx(['压缩的段落一', '压缩的段落二']), OPTIONS)
  assert.equal(result.ok, true)
  assert.equal(result.text, '压缩的段落一\n压缩的段落二')
})

// ---------------------------------------------------------------------------
// xlsx
// ---------------------------------------------------------------------------

test('xlsx：共享字符串 / 内联字符串 / 数字 / 布尔，且空单元格补空列对齐', () => {
  const bytes = buildXlsx({
    sharedStrings: ['姓名', '成绩', '张三'],
    sheets: [
      {
        name: '成绩表',
        rows: [
          [{ value: '0', type: 'shared' }, { value: '1', type: 'shared' }],
          // B 列留空（跳过 ref），C 列是内联字符串
          [{ ref: 'A2', value: '2', type: 'shared' }, { ref: 'C2', value: '缺考', type: 'inline' }],
          [{ ref: 'A3', value: '88', type: 'number' }, { ref: 'B3', value: '1', type: 'boolean' }],
        ],
      },
    ],
  })
  const result = extractXlsx(bytes, OPTIONS)
  assert.equal(result.ok, true)
  assert.match(result.text, /## 工作表：成绩表/)
  const lines = result.text.split('\n').filter(line => line.trim() !== '' && !line.startsWith('#') && !line.startsWith('（') && !line.startsWith('列类型'))
  assert.deepEqual(lines, ['姓名\t成绩', '张三\t\t缺考', '88\tTRUE'])
})

test('xlsx：日期列保留序列号并在表头标注列类型', () => {
  const bytes = buildXlsx({
    dateStyles: [0],
    sheets: [
      {
        name: '日志',
        rows: [
          [{ value: '日期' }, { value: '事件' }],
          [{ ref: 'A2', value: '45000', style: 0 }, { ref: 'B2', value: '开题' }],
        ],
      },
    ],
  })
  const result = extractXlsx(bytes, OPTIONS)
  assert.match(result.text, /45000/, '序列号原样保留')
  assert.match(result.text, /列类型提示：第 1 列为日期列/)
})

test('xlsx：多工作表按 workbook 顺序渲染', () => {
  const bytes = buildXlsx({
    sheets: [
      { name: '第一表', rows: [[{ value: 'a' }]] },
      { name: '第二表', rows: [[{ value: 'b' }]] },
    ],
  })
  const result = extractXlsx(bytes, OPTIONS)
  const first = result.text.indexOf('## 工作表：第一表')
  const second = result.text.indexOf('## 工作表：第二表')
  assert.ok(first >= 0 && second > first, '工作表顺序应与 workbook.xml 一致')
  assert.match(result.note ?? '', /共 2 个工作表/)
})

test('xlsx：空工作簿（无数据）返回 ok:false', () => {
  const bytes = buildXlsx({ sheets: [{ name: '空表', rows: [] }] })
  const result = extractXlsx(bytes, OPTIONS)
  assert.equal(result.ok, false)
  assert.match(result.note ?? '', /都是空的/)
})

test('xlsx：解析辅助函数', () => {
  assert.deepEqual(parseWorkbookSheets('<sheets><sheet name="甲" sheetId="1" r:id="rId1"/><sheet name="乙" sheetId="2" r:id="rId2"/></sheets>'), [
    { name: '甲', relId: 'rId1' },
    { name: '乙', relId: 'rId2' },
  ])
  const rels = parseWorkbookRels('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet9.xml"/></Relationships>')
  assert.equal(rels.get('rId1'), 'worksheets/sheet1.xml')
  assert.equal(rels.get('rId2'), '/xl/worksheets/sheet9.xml')
  assert.deepEqual(parseSharedStrings('<sst><si><t>甲</t></si><si><r><t>乙</t></r><r><t>丙</t></r></si></sst>'), ['甲', '乙丙'])
  assert.equal(columnIndex('A1'), 0)
  assert.equal(columnIndex('B2'), 1)
  assert.equal(columnIndex('AA1'), 26)
  assert.equal(isDateFormatCode('yyyy-mm-dd'), true)
  assert.equal(isDateFormatCode('0.00%'), false)
  const flags = parseStyleDateFlags('<styleSheet><cellXfs count="3"><xf numFmtId="14"/><xf numFmtId="0"/><xf numFmtId="165"/></cellXfs><numFmts><numFmt numFmtId="165" formatCode="yyyy/m/d"/></numFmts></styleSheet>')
  assert.deepEqual(flags, [true, false, true])
})

// ---------------------------------------------------------------------------
// pptx
// ---------------------------------------------------------------------------

test('pptx：多页按页码数字顺序（而非字典序）渲染', () => {
  const bytes = buildPptx([
    ['第一页标题', '第一页正文'],
    ['第二页标题'],
    ['第十页标题'],
  ], '答辩PPT')
  const result = extractPptx(bytes, OPTIONS)
  assert.equal(result.ok, true)
  assert.equal(result.title, '答辩PPT')
  const p1 = result.text.indexOf('## 第 1 页')
  const p2 = result.text.indexOf('## 第 2 页')
  const p3 = result.text.indexOf('## 第 3 页')
  assert.ok(p1 >= 0 && p2 > p1 && p3 > p2)
  assert.match(result.text, /第一页标题\n第一页正文/)
})

test('pptx：slideNumber / sortSlides 按数字排序', () => {
  assert.equal(slideNumber('ppt/slides/slide12.xml'), 12)
  assert.deepEqual(
    sortSlides(['ppt/slides/slide10.xml', 'ppt/slides/slide2.xml', 'ppt/slides/slide1.xml']),
    ['ppt/slides/slide1.xml', 'ppt/slides/slide2.xml', 'ppt/slides/slide10.xml'],
  )
})

test('pptx：无文本的页面如实说明并给出低置信标记', () => {
  const bytes = buildPptx([[], [], ['有字']])
  const result = extractPptx(bytes, OPTIONS)
  assert.equal(result.ok, true)
  assert.match(result.text, /本页没有文本/)
  assert.equal(result.lowConfidence, true)
})

test('pptx：非 pptx 的 ZIP 报可读错误', () => {
  const result = extractPptx(buildDocx({ paragraphs: ['x'] }), OPTIONS)
  assert.equal(result.ok, false)
  assert.match(result.note ?? '', /不是有效的 \.pptx/)
})

// ---------------------------------------------------------------------------
// 统一入口
// ---------------------------------------------------------------------------

test('统一入口：按文件名判定类型并抽取', () => {
  const docx = extractText(buildDocx({ paragraphs: ['正文'] }), '模板.docx', OPTIONS)
  assert.equal(docx.kind, 'docx')
  assert.equal(docx.text, '正文')

  const xlsx = extractText(buildXlsx({ sheets: [{ name: 'S', rows: [[{ value: '1' }]] }] }), '数据.xlsx', OPTIONS)
  assert.equal(xlsx.kind, 'xlsx')
  assert.equal(xlsx.ok, true)
})

test('统一入口：maxChars 截断并标记 truncated', () => {
  const bytes = buildDocx({ paragraphs: ['长'.repeat(500)] })
  const result = extractText(bytes, '长文.docx', { maxChars: 120 })
  assert.equal(result.truncated, true)
  assert.ok(result.text.length <= 120, `截断后长度 ${result.text.length} 应不超过上限`)
  assert.match(result.text, /已截断/)
})
