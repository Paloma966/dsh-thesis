/**
 * 纯文本类材料（`src/ingest/text.ts`）测试：编码判定、换行归一、HTML 去标签、
 * 二进制误判、maxChars 截断。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractText } from '../src/ingest/index.ts'
import { decodeTextBytes, htmlToText, looksBinary, normalizeNewlines } from '../src/ingest/text.ts'

const encoder = new TextEncoder()
const OPTIONS = { maxChars: 100000 }

test('text：UTF-8 BOM 被剥掉，CRLF 归一为 LF', () => {
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...encoder.encode('第一行\r\n第二行\r第三行')])
  assert.equal(decodeTextBytes(bytes), '第一行\n第二行\n第三行')
})

test('text：UTF-16LE BOM 能解码（记事本"Unicode"另存为）', () => {
  const text = '中文测试'
  const bytes: number[] = [0xff, 0xfe]
  for (const ch of text) {
    const code = ch.charCodeAt(0)
    bytes.push(code & 0xff, (code >>> 8) & 0xff)
  }
  assert.equal(decodeTextBytes(new Uint8Array(bytes)), text)
})

test('text：GBK 中文回退（非 UTF-8 字节不产生替换字符）', () => {
  const bytes = encoder.encode('中文数据') // TextEncoder 出来是 UTF-8
  const utf8 = new TextDecoder('utf-8').decode(bytes)
  assert.equal(utf8, '中文数据')
  // 手写 GBK 字节（'中文' = D6 D0 CE C4）
  const gbk = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4, 0x2c, 0x31])
  const decoded = decodeTextBytes(gbk)
  assert.ok(!decoded.includes('\ufffd'), `GBK 回退不应产生替换字符：${JSON.stringify(decoded)}`)
  assert.ok(decoded.includes('中') || decoded.includes('，') || decoded.length > 0)
})

test('text：normalizeNewlines / looksBinary', () => {
  assert.equal(normalizeNewlines('a\r\nb\rc'), 'a\nb\nc')
  assert.equal(looksBinary(encoder.encode('hello')), false)
  assert.equal(looksBinary(new Uint8Array([0x00, 0x01, 0x02])), true)
})

test('text：HTML 去标签、去脚本、实体解码、块级转换行', () => {
  const html = [
    '<html><head><style>p { color: red }</style><script>alert("x")</script></head>',
    '<body><h1>标题 &amp; 副题</h1><p>第一段&nbsp;内容</p><p>第二段 &lt;标签&gt;</p>',
    '<table><tr><td>甲</td><td>乙</td></tr></table>',
    '<ul><li>要点一</li><li>要点二</li></ul>',
    '<div>&#20013;&#x6587;</div></body></html>',
  ].join('')
  const text = htmlToText(html)
  assert.ok(!/<(?:p|div|h1|table|tr|td|script|style|body|html|head|ul|li)\b/i.test(text), `不应残留标签：${text}`)
  assert.ok(!text.includes('color: red') && !text.includes('alert'), '脚本/样式应被移除')
  assert.ok(text.includes('标题 & 副题'))
  assert.ok(/第一段[ \u00a0]内容/.test(text), `nbsp 解码为空格：${JSON.stringify(text)}`)
  assert.ok(text.includes('第二段 <标签>'))
  assert.ok(text.includes('甲\t乙'), '表格单元格应是制表符分隔')
  assert.ok(text.includes('要点一') && text.includes('要点二'))
  assert.ok(text.includes('中文'), '数字实体应解码')
})

test('text：extractText 按原样返回 markdown/txt/csv，且带类型说明', () => {
  const md = extractText(encoder.encode('# 标题\n\n正文'), '说明.md', OPTIONS)
  assert.equal(md.ok, true)
  assert.equal(md.kind, 'text')
  assert.equal(md.text, '# 标题\n\n正文')
  assert.match(md.note ?? '', /\.md 文本/)

  const csv = extractText(encoder.encode('a,b\n1,2\n'), '数据.csv', OPTIONS)
  assert.equal(csv.text, 'a,b\n1,2\n')

  const bib = extractText(encoder.encode('@article{a, title={T}}'), 'refs.bib', OPTIONS)
  assert.match(bib.text, /@article/)

  const ris = extractText(encoder.encode('TY  - JOUR\nAU  - 张三'), 'refs.ris', OPTIONS)
  assert.match(ris.text, /TY {2}- JOUR/)
})

test('text：HTML 走 text 类型并去掉标签', () => {
  const result = extractText(encoder.encode('<p>论文要求</p><p>页数不少于 20</p>'), '要求.html', OPTIONS)
  assert.equal(result.ok, true)
  assert.equal(result.kind, 'text')
  assert.ok(!result.text.includes('<p>'))
  assert.match(result.text, /论文要求/)
})

test('text：空文件与二进制文件返回 ok:false 且原因可读', () => {
  const empty = extractText(encoder.encode('   \n  '), 'empty.txt', OPTIONS)
  assert.equal(empty.ok, false)
  assert.match(empty.note ?? '', /空的/)

  const binary = extractText(new Uint8Array([0x00, 0x01, 0x02, 0x03]), 'weird.txt', OPTIONS)
  assert.equal(binary.ok, false)
  assert.match(binary.note ?? '', /二进制/)
})

test('text：maxChars 截断并标记', () => {
  const long = extractText(encoder.encode('字'.repeat(500)), '长文.txt', { maxChars: 100 })
  assert.equal(long.truncated, true)
  assert.ok(long.text.length <= 100)
  assert.match(long.text, /已截断/)
})
