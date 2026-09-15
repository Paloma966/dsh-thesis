/**
 * 纯文本类材料摄取：`.md/.markdown/.txt/.csv/.tsv/.json/.yaml/.yml/.bib/.ris/.html`。
 *
 * 处理内容：
 * - 编码判定：UTF-8 BOM / UTF-16 LE·BE BOM 先剥 BOM；再按"UTF-8 解码是否出现
 *   替换字符"判断，必要时回退 GBK（中文 Windows 的记事本/CSV 常见）；
 * - 换行归一：CRLF/CR → LF；
 * - HTML：去掉 `<script>/<style>`、块级标签转换行、去掉其余标签、解码常见实体，
 *   得到可读纯文本（不引第三方解析器）。
 *
 * @module dsh-thesis/ingest
 */

import { decodeXmlEntities } from './ooxml.ts'
import { failureResult, successResult, type ExtractOptions, type ExtractResult } from './types.ts'

/** `node:fs` 读进来的字节 → 文本（BOM 与编码归一）。 */
export function decodeTextBytes(bytes: Uint8Array): string {
  // UTF-16 BOM（Windows 记事本"Unicode"另存为）
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return decodeUtf16(bytes.subarray(2), true)
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return decodeUtf16(bytes.subarray(2), false)
  }
  // UTF-8 BOM
  const body = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
    ? bytes.subarray(3)
    : bytes

  const utf8 = decodeWith(new TextDecoder('utf-8'), body)
  if (utf8 !== undefined && !utf8.includes('\ufffd')) return normalizeNewlines(utf8)

  // 回退 GBK（环境不支持时保留 UTF-8 结果）
  try {
    const gbk = decodeWith(new TextDecoder('gbk'), body)
    if (gbk !== undefined && (utf8 === undefined || countReplacement(gbk) < countReplacement(utf8))) {
      return normalizeNewlines(gbk)
    }
  } catch {
    // 没有 ICU：忽略
  }
  return normalizeNewlines(utf8 ?? '')
}

function decodeWith(decoder: TextDecoder, bytes: Uint8Array): string | undefined {
  try {
    return decoder.decode(bytes)
  } catch {
    return undefined
  }
}

function decodeUtf16(bytes: Uint8Array, littleEndian: boolean): string {
  let out = ''
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const code = littleEndian ? bytes[i]! | (bytes[i + 1]! << 8) : (bytes[i]! << 8) | bytes[i + 1]!
    out += String.fromCharCode(code)
  }
  return normalizeNewlines(out)
}

function countReplacement(text: string): number {
  let count = 0
  for (const ch of text) if (ch === '\ufffd') count += 1
  return count
}

/** CRLF / CR → LF。 */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

/** HTML 命名实体（够覆盖中文网页/文档导出的常见字符）。 */
const HTML_ENTITIES: Record<string, string> = {
  nbsp: '\u00a0',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  shy: '',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  middot: '·',
  bull: '•',
  copy: '©',
  reg: '®',
  trade: '™',
  laquo: '«',
  raquo: '»',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  times: '×',
  divide: '÷',
  deg: '°',
  plusmn: '±',
  ne: '≠',
  le: '≤',
  ge: '≥',
  rarr: '→',
  larr: '←',
  sect: '§',
  para: '¶',
  dagger: '†',
  euro: '€',
  pound: '£',
  yen: '¥',
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  delta: 'δ',
  mu: 'μ',
  pi: 'π',
  sigma: 'σ',
  omega: 'ω',
}

/** 解 HTML 实体（数字实体 + 常见命名实体，其余原样保留）。 */
export function decodeHtmlEntities(input: string): string {
  const named = /\&([a-zA-Z][a-zA-Z0-9]{1,31});/g
  return decodeXmlEntities(input).replace(named, (match, name: string) => HTML_ENTITIES[name.toLowerCase()] ?? match)
}

/** HTML → 纯文本（去标签、块级转换行、解码实体）。 */
export function htmlToText(html: string): string {
  let text = html
  // 注释
  text = text.replace(/<!--[\s\S]*?-->/g, '')
  // 脚本/样式整块丢弃
  text = text.replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
  // 表格单元格 → 制表符；换行标签 → 换行
  text = text.replace(/<\/t[dh]\s*>/gi, '\t')
  text = text.replace(/<br\s*\/?>/gi, '\n')
  text = text.replace(/<\/(p|div|li|tr|h[1-6]|section|article|blockquote|pre|table|ul|ol|dl|dd|dt|figcaption)\s*>/gi, '\n')
  text = text.replace(/<(hr|li)\b[^>]*>/gi, '\n')
  // 其余标签直接去掉
  text = text.replace(/<[^>]*>/g, '')
  text = decodeHtmlEntities(text)
  // 行内空白整理：去每行首尾空格、压掉 3 个以上空行
  return text
    .split('\n')
    .map(line => line.replace(/[ \t]+$/, '').replace(/^[ \t]+/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/** 是否像二进制（含 NUL 或大量控制字符）——防止把 .dat 当文本读。 */
export function looksBinary(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, 4096))
  let control = 0
  for (const byte of sample) {
    if (byte === 0) return true
    if (byte < 9 || (byte > 13 && byte < 32)) control += 1
  }
  return sample.length > 0 && control / sample.length > 0.05
}

/** 门面用入口：按扩展名给的信息做纯文本抽取。 */
export function extractText(bytes: Uint8Array, filename: string, options: ExtractOptions): ExtractResult {
  const lower = filename.toLowerCase()
  const isHtml = lower.endsWith('.html') || lower.endsWith('.htm')
  if (looksBinary(bytes) && !isHtml) {
    return failureResult('这个文件看起来是二进制（不是文本）：请确认扩展名是否正确，或提供可读的文本版本。')
  }
  const decoded = decodeTextBytes(bytes)
  const text = isHtml ? htmlToText(decoded) : decoded.replace(/^\ufeff/, '')
  if (text.trim() === '') {
    return failureResult('文件是空的（或去掉 HTML 标签后没有文字）。')
  }
  const extension = lower.slice(lower.lastIndexOf('.'))
  const kind = isHtml ? 'HTML（已去标签）' : `${extension === lower ? '纯文本' : extension} 文本`
  return successResult({
    text,
    maxChars: options.maxChars,
    note: `按${kind}读取。`,
  })
}
