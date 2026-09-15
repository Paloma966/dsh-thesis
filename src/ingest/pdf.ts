/**
 * `.pdf` **尽力而为**的文本抽取（零依赖）。
 *
 * 能抽出来的：
 * - 文本型 PDF：解析间接对象、解 `FlateDecode`（`node:zlib` 的 `inflateRawSync`）、
 *   `ASCIIHexDecode`/`ASCII85Decode` 流；扫描内容流里 `BT…ET` 块中的
 *   `Tj` / `TJ` / `'` / `"` 操作数（含 `\(` `\)` `\\` 与八进制转义）；
 * - 有 `ToUnicode` CMap 的字体：用 CMap 还原字符（含中文、符号字体）；
 * - 走 `/Resources /Font` 的字体名 → CMap 映射，`Tf` 切换字体时同步切换解码表。
 *
 * **抽不出来的（会明确说，绝不编造）**：
 * - 加密 PDF（`/Encrypt`）：直接失败；
 * - 扫描版 PDF（页面只有图片、没有文字对象）：失败并提示"请提供 .docx 或复制正文"；
 * - 对象流（Object Stream）/ 交叉引用流：不解析，可能少读页面（有提示）；
 * - 只用 CID 编码、又没有 ToUnicode 的嵌入子集字体：字节无法还原成字符，
 *   结果会被清成占位符并标 `lowConfidence`；
 * - 表格/分栏：PDF 没有语义，行序按内容流顺序，可能错乱。
 *
 * 文字抽取率低（少于 200 字符但页数 > 3）时结果带 `lowConfidence: true`。
 *
 * @module dsh-thesis/ingest
 */

import { inflateRawSync } from 'node:zlib'
import { failureResult, truncateText, type ExtractOptions, type ExtractResult } from './types.ts'

/** 单文件字节上限（PDF 可能很大，超过就不硬啃）。 */
export const PDF_MAX_BYTES = 64 * 1024 * 1024
/** 单流解压上限。 */
const STREAM_LIMIT = 16 * 1024 * 1024
/** 解析的对象数上限。 */
const OBJECT_LIMIT = 20000
/** 低置信阈值。 */
const LOW_CHARS = 200
const LOW_PAGES = 3
/** TJ 数组里超过该调整量（1000 分之一 em）就补一个空格。 */
const TJ_SPACE_THRESHOLD = 120

// ---------------------------------------------------------------------------
// 字节 → latin1 字符串（PDF 的语法字符全是 ASCII，数据用等值 latin1 保真）
// ---------------------------------------------------------------------------

/** 等值 latin1 解码（每字节一个码位，绝不丢数据）。 */
export function bytesToLatin1(bytes: Uint8Array): string {
  let out = ''
  const chunk = 8192
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return out
}

// ---------------------------------------------------------------------------
// 对象与流
// ---------------------------------------------------------------------------

type ObjectKind = 'page' | 'stream' | 'dict' | 'unknown'

interface PdfObject {
  readonly num: number
  readonly dict: string
  readonly stream?: Uint8Array
  readonly kind: ObjectKind
}

/** CFX 风格的过滤器个数统计（只用兼容名，`/Fl` 这类短名不猜）。 */
function countFilter(dict: string, names: readonly string[]): number {
  let count = 0
  for (const name of names) {
    const re = new RegExp(`/${name}\\b`, 'g')
    const found = dict.match(re)
    if (found !== null) count += found.length
  }
  return count
}

function isObjectStream(dict: string): boolean {
  return /\/Type\s*\/ObjStm\b/.test(dict)
}

function classify(dict: string, hasStream: boolean): ObjectKind {
  if (/\/Type\s*\/Page[^s]/.test(dict) || /\/Type\s*\/Page\s*(?:\/|>>)/.test(dict)) return 'page'
  if (hasStream) return 'stream'
  if (dict.length > 0) return 'dict'
  return 'unknown'
}

/** 从对象体里取流数据（未解压）。 */
function extractStream(body: string, dict: string): Uint8Array | undefined {
  const decoded = latin1ToBytes(body)
  const marker = /stream\r\n|stream\n|stream\r/.exec(body)
  if (marker === null) return undefined
  const start = marker.index + marker[0].length
  const lengthMatch = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict)
  if (lengthMatch !== null) {
    const length = Number.parseInt(lengthMatch[1]!, 10)
    if (Number.isFinite(length) && length >= 0 && start + length <= decoded.length) {
      return decoded.subarray(start, start + length)
    }
  }
  const end = body.indexOf('endstream', start)
  if (end === -1) return undefined
  // 数据末尾的换行不属于流内容。
  let stop = end
  if (stop > start && decoded[stop - 1] === 0x0a) stop -= 1
  if (stop > start && decoded[stop - 1] === 0x0d) stop -= 1
  return decoded.subarray(start, stop)
}

/** latin1 字符串 → 字节。 */
function latin1ToBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff
  return out
}

/** 解析全部间接对象（`N G obj … endobj`）。 */
export function parseObjects(raw: string): PdfObject[] {
  const objects: PdfObject[] = []
  const re = /(\d+)\s+(\d+)\s+obj\b/g
  let match = re.exec(raw)
  while (match !== null) {
    if (objects.length >= OBJECT_LIMIT) break
    const num = Number.parseInt(match[1]!, 10)
    const bodyStart = re.lastIndex
    const end = raw.indexOf('endobj', bodyStart)
    const body = end === -1 ? raw.slice(bodyStart) : raw.slice(bodyStart, end)
    const streamAt = body.search(/stream\r\n|stream\n|stream\r/)
    const dict = streamAt === -1 ? body : body.slice(0, streamAt)
    const stream = extractStream(body, dict)
    objects.push({ num, dict, ...(stream !== undefined ? { stream } : {}), kind: classify(dict, stream !== undefined) })
    if (end === -1) break
    re.lastIndex = end + 'endobj'.length
    match = re.exec(raw)
  }
  return objects
}

// ---------------------------------------------------------------------------
// 流解码
// ---------------------------------------------------------------------------

function asciiHexDecode(bytes: Uint8Array): Uint8Array {
  const text = bytesToLatin1(bytes)
  const digits: number[] = []
  for (const ch of text) {
    if (ch === '>') break
    const code = ch.charCodeAt(0)
    if (code >= 48 && code <= 57) digits.push(code - 48)
    else if (code >= 65 && code <= 70) digits.push(code - 55)
    else if (code >= 97 && code <= 102) digits.push(code - 87)
  }
  const out = new Uint8Array(Math.floor(digits.length / 2))
  for (let i = 0; i < out.length; i += 1) out[i] = (digits[i * 2]! << 4) | digits[i * 2 + 1]!
  return out
}

function ascii85Decode(bytes: Uint8Array): Uint8Array {
  const text = bytesToLatin1(bytes)
  const out: number[] = []
  let group: number[] = []
  for (const ch of text) {
    if (ch === '~') break
    if (ch === 'z' && group.length === 0) {
      out.push(0, 0, 0, 0)
      continue
    }
    const code = ch.charCodeAt(0)
    if (code < 33 || code > 117) continue
    group.push(code - 33)
    if (group.length === 5) {
      let value = 0
      for (const digit of group) value = value * 85 + digit
      out.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff)
      group = []
    }
  }
  if (group.length > 1) {
    const pad = 5 - group.length
    for (let i = 0; i < pad; i += 1) group.push(84)
    let value = 0
    for (const digit of group) value = value * 85 + digit
    const full = [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
    out.push(...full.slice(0, 4 - pad))
  }
  return new Uint8Array(out)
}

/** 按过滤器解码一个流；返回 undefined 表示方法不支持（调用方据此提示）。 */
export function decodeStream(data: Uint8Array, dict: string): Uint8Array | undefined {
  const flate = countFilter(dict, ['FlateDecode', 'Fl'])
  if (flate > 0) {
    try {
      // 注意：**不能**把 maxOutputLength 设成 /Length——那是压缩后长度，
      // 解压结果通常更大，会误判成失败。这里只设硬上限防爆。
      return inflateRawSync(data, { maxOutputLength: STREAM_LIMIT })
    } catch {
      try {
        // 有些流前面带 zlib 头（不应出现，但存在这种坏文件）：去掉两字节再试。
        return inflateRawSync(data.subarray(2), { maxOutputLength: STREAM_LIMIT })
      } catch {
        return undefined
      }
    }
  }
  if (countFilter(dict, ['ASCIIHexDecode', 'AHx']) > 0) return asciiHexDecode(data)
  if (countFilter(dict, ['ASCII85Decode', 'A85']) > 0) return ascii85Decode(data)
  // 无过滤器：原始字节
  if (!/\/Filter\b/.test(dict)) return data
  // LZW / RunLength / DCT / JPX 等：不实现，交给调用方提示。
  return undefined
}

// ---------------------------------------------------------------------------
// ToUnicode CMap
// ---------------------------------------------------------------------------

interface FontMap {
  readonly codeBytes: 1 | 2
  readonly map: Map<number, string>
}

function hexToCode(hex: string): number {
  const value = Number.parseInt(hex, 16)
  return Number.isFinite(value) ? value : 0
}

function parseHexString(hex: string): string {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '')
  let out = ''
  for (let i = 0; i + 3 < clean.length + 1 && i + 4 <= clean.length; i += 4) {
    const code = Number.parseInt(clean.slice(i, i + 4), 16)
    if (Number.isFinite(code) && code !== 0) out += String.fromCharCode(code)
  }
  return out
}

/** 解析 ToUnicode CMap 流 → 字体映射。 */
export function parseToUnicode(cmapText: string): FontMap {
  const map = new Map<number, string>()
  let codeBytes: 1 | 2 = 1
  const spaceMatch = /begincodespacerange([\s\S]*?)endcodespacerange/.exec(cmapText)
  if (spaceMatch !== null) {
    for (const item of spaceMatch[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      if ((item[1] ?? '').length >= 4) codeBytes = 2
    }
  }

  const bfchar = /beginbfchar([\s\S]*?)endbfchar/g
  let block = bfchar.exec(cmapText)
  while (block !== null) {
    for (const item of block[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      map.set(hexToCode(item[1]!), parseHexString(item[2]!))
    }
    block = bfchar.exec(cmapText)
  }

  const bfrange = /beginbfrange([\s\S]*?)endbfrange/g
  block = bfrange.exec(cmapText)
  while (block !== null) {
    for (const item of block[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]+>|\[[\s\S]*?\])/g)) {
      const lo = hexToCode(item[1]!)
      const hi = hexToCode(item[2]!)
      const dest = item[3]!
      if (dest.startsWith('[')) {
        let offset = 0
        for (const entry of dest.matchAll(/<([0-9a-fA-F]+)>/g)) {
          if (lo + offset <= hi) map.set(lo + offset, parseHexString(entry[1]!))
          offset += 1
        }
      } else {
        const base = parseHexString(dest.slice(1, -1))
        const baseCode = base.length > 0 ? base.charCodeAt(0) : 0
        for (let code = lo; code <= hi && code - lo < 65536; code += 1) {
          map.set(code, String.fromCharCode(baseCode + (code - lo)))
        }
      }
    }
    block = bfrange.exec(cmapText)
  }
  return { codeBytes, map }
}

// ---------------------------------------------------------------------------
// 字体资源：/F1 → FontMap
// ---------------------------------------------------------------------------

interface FontResource {
  readonly codeBytes: 1 | 2
  readonly map: Map<number, string> | undefined
}

/** 解析一页（或全局）的 `/Resources` → 字体名到解码表的映射。 */
export function buildFontTables(raw: string, objects: readonly PdfObject[]): Map<string, FontResource> {
  const tables = new Map<string, FontResource>()
  // 字体对象号 → ToUnicode 对象号
  const fontToUnicode = new Map<number, number>()
  for (const object of objects) {
    const match = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(object.dict)
    if (match !== null) fontToUnicode.set(object.num, Number.parseInt(match[1]!, 10))
  }

  const resourceRe = /\/Font\s*<<([^>]*)>>/g
  let match = resourceRe.exec(raw)
  while (match !== null) {
    for (const item of match[1]!.matchAll(/\/([A-Za-z0-9#+._-]+)\s+(\d+)\s+\d+\s+R/g)) {
      const name = item[1]!
      const fontNum = Number.parseInt(item[2]!, 10)
      const cmapNum = fontToUnicode.get(fontNum)
      let resource: FontResource = { codeBytes: 1, map: undefined }
      if (cmapNum !== undefined) {
        const cmapObject = objects.find(object => object.num === cmapNum)
        if (cmapObject?.stream !== undefined) {
          const decoded = decodeStream(cmapObject.stream, cmapObject.dict)
          if (decoded !== undefined) {
            const parsed = parseToUnicode(bytesToLatin1(decoded))
            resource = { codeBytes: parsed.codeBytes, map: parsed.map }
          }
        }
      }
      if (!tables.has(name)) tables.set(name, resource)
    }
    match = resourceRe.exec(raw)
  }

  // 回退：全局唯一的 ToUnicode（只有一个字体时非常常见）。
  if (tables.size === 0) {
    const withCmap = fontToUnicode.values().next()
    if (withCmap.done !== true) {
      const cmapObject = objects.find(object => object.num === withCmap.value)
      if (cmapObject?.stream !== undefined) {
        const decoded = decodeStream(cmapObject.stream, cmapObject.dict)
        if (decoded !== undefined) {
          const parsed = parseToUnicode(bytesToLatin1(decoded))
          tables.set('*', { codeBytes: parsed.codeBytes, map: parsed.map })
        }
      }
    }
  }
  return tables
}

// ---------------------------------------------------------------------------
// 内容流文本抽取
// ---------------------------------------------------------------------------

const WHITESPACE = new Set(['\u0000', '\t', '\n', '\u000c', '\r', ' '])

/** 空白判定（含 PDF 规范里的 \\0 \\t \\n \\f \\r 空格）。 */
function isWhitespace(ch: string | undefined): boolean {
  return ch !== undefined && WHITESPACE.has(ch)
}

/** 十六进制字符串（`<4E2D>` 的内容）→ 字节。 */
function hexToBytes(hexText: string): number[] {
  const hex = hexText.replace(/[^0-9a-fA-F]/g, '')
  const bytes: number[] = []
  for (let k = 0; k + 1 < hex.length; k += 2) bytes.push(Number.parseInt(hex.slice(k, k + 2), 16))
  if (hex.length % 2 === 1) bytes.push(Number.parseInt(`${hex.slice(-1)}0`, 16))
  return bytes
}

/** 若字节看起来就是一个数字字面量（`-300` / `0.5`），返回数值；否则 undefined。 */
function numericStringValue(bytes: readonly number[]): number | undefined {
  if (bytes.length === 0) return undefined
  let text = ''
  for (const byte of bytes) {
    if (byte > 0x7f) return undefined
    text += String.fromCharCode(byte)
  }
  if (!/^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(text.trim())) return undefined
  const value = Number(text.trim())
  return Number.isFinite(value) ? value : undefined
}

/** TJ 数组项：字符串或字距调整量。 */
type TJItem = { readonly kind: 'string'; readonly bytes: number[] } | { readonly kind: 'number'; readonly value: number }

/** 文本操作数：字符串字面量、数组（TJ）或名字/数字。 */
type PdfOperand = number[] | TJItem[] | string | number

/** 区分「字节数组」与「TJ 项数组」。 */
function isNumberArray(operand: readonly TJItem[] | readonly number[]): operand is readonly number[] {
  return operand.length === 0 || typeof operand[0] === 'number'
}

/** 找数组（`[` 已消费）的配对 `]` 位置；找不到返回 -1。字符串内的 `]` 不算。 */
function findArrayEnd(content: string, start: number): number {
  let i = start
  let depth = 0
  while (i < content.length) {
    const ch = content[i]!
    if (ch === '(') {
      i = readPdfString(content, i).next
      continue
    }
    if (ch === '[') { depth += 1; i += 1; continue }
    if (ch === ']') {
      if (depth === 0) return i
      depth -= 1
      i += 1
      continue
    }
    i += 1
  }
  return -1
}

/** 解析数组正文（不含方括号）为「字符串 / 数字」项序列。 */
export function parseArrayItems(body: string): TJItem[] {
  const items: TJItem[] = []
  let i = 0
  while (i < body.length) {
    const ch = body[i]!
    if (isWhitespace(ch)) { i += 1; continue }
    if (ch === '(') {
      const read = readPdfString(body, i)
      // 有些生成器把字距调整量也写成字符串形式 `(-300)`：
      // 内容是纯数字就当数字处理（否则会被当成正文显示出来）。
      const asNumber = numericStringValue(read.bytes)
      if (asNumber !== undefined) items.push({ kind: 'number', value: asNumber })
      else items.push({ kind: 'string', bytes: read.bytes })
      i = read.next
      continue
    }
    if (ch === '<') {
      const end = body.indexOf('>', i)
      if (end === -1) break
      items.push({ kind: 'string', bytes: hexToBytes(body.slice(i + 1, end)) })
      i = end + 1
      continue
    }
    if (ch === ']') { i += 1; continue }
    let end = i
    while (end < body.length && !isWhitespace(body[end]!) && !isDelimiter(body[end]!)) end += 1
    const text = body.slice(i, end)
    const value = Number(text)
    if (text !== '' && Number.isFinite(value)) items.push({ kind: 'number', value })
    i = end === i ? i + 1 : end
  }
  return items
}

function isDelimiter(ch: string): boolean {
  return ch === '(' || ch === ')' || ch === '<' || ch === '>' || ch === '[' || ch === ']'
    || ch === '{' || ch === '}' || ch === '/' || ch === '%'
}
/** 读一个 PDF 字符串字面量（调用时 `text[i]` 是 `(`）。 */
export function readPdfString(text: string, start: number): { bytes: number[]; next: number } {
  const bytes: number[] = []
  let depth = 1
  let i = start + 1
  while (i < text.length) {
    const ch = text[i]!
    if (ch === '\\') {
      const next = text[i + 1]
      i += 2
      switch (next) {
        case 'n': bytes.push(0x0a); break
        case 'r': bytes.push(0x0d); break
        case 't': bytes.push(0x09); break
        case 'b': bytes.push(0x08); break
        case 'f': bytes.push(0x0c); break
        case '(': bytes.push(0x28); break
        case ')': bytes.push(0x29); break
        case '\\': bytes.push(0x5c); break
        case '\r':
          if (text[i] === '\n') i += 1
          break
        case '\n': break
        default:
          if (next !== undefined && next >= '0' && next <= '7') {
            let octal = next
            let consumed = 1
            while (consumed < 3) {
              const digit = text[i]
              if (digit === undefined || digit < '0' || digit > '7') break
              octal += digit
              i += 1
              consumed += 1
            }
            bytes.push(Number.parseInt(octal, 8) & 0xff)
          } else if (next !== undefined) {
            bytes.push(next.charCodeAt(0) & 0xff)
          }
          break
      }
      continue
    }
    if (ch === '(') {
      depth += 1
      bytes.push(0x28)
      i += 1
      continue
    }
    if (ch === ')') {
      depth -= 1
      if (depth === 0) {
        // 配对结束：next 指向 `)` 之后。
        return { bytes, next: i + 1 }
      }
      bytes.push(0x29)
      i += 1
      continue
    }
    bytes.push(ch.charCodeAt(0) & 0xff)
    i += 1
  }
  // 未闭合：返回已读内容与串尾位置（不抛错，调用方按 best-effort 处理）。
  return { bytes, next: i }
}

/** 用字体表解码一串字节；返回是否发生了「无法映射」的字节。 */
function decodeWithFont(bytes: readonly number[], font: FontResource | undefined): { text: string; unmapped: boolean } {
  let out = ''
  let unmapped = false
  if (font?.map !== undefined && font.map.size > 0) {
    const step = font.codeBytes
    for (let i = 0; i < bytes.length; i += step) {
      let code = bytes[i]!
      if (step === 2) code = (code << 8) | (bytes[i + 1] ?? 0)
      const mapped = font.map.get(code)
      if (mapped !== undefined) out += mapped
      else {
        unmapped = true
        // 未映射的码位按单字节 latin1 兜底，至少保留可读的 ASCII。
        if (step === 1 && code >= 32 && code !== 127) out += String.fromCharCode(code)
      }
    }
    return { text: out, unmapped }
  }
  for (const byte of bytes) {
    // 无 Unicode 映射：按 latin1 直读（标准 WinAnsi 文档这一段是对的）。
    if (byte >= 32 || byte === 9 || byte === 10 || byte === 13) out += String.fromCharCode(byte)
  }
  return { text: out, unmapped: true }
}

interface ContentExtract {
  readonly text: string
  readonly strings: number
  readonly unmappedSources: number
}

/** 扫描一段内容流，抽取文本操作数。 */
export function extractContentText(content: string, fonts: Map<string, FontResource>): ContentExtract {
  let out = ''
  let strings = 0
  let unmappedSources = 0
  let currentFont: FontResource | undefined = fonts.get('*')
  let inText = false
  const operands: PdfOperand[] = []
  let i = 0

  // 词间空格的状态要**跨 TJ 操作**保留：PDF 里行内空格常写成
  // 「上一段结尾 + 负字距调整」，只在单个数组内部判断会漏掉。
  let lastCharIsSpace = true
  let pendingWordSpace = false

  /** 换行：重置"行首"状态。 */
  const newline = (): void => {
    out += '\n'
    lastCharIsSpace = true
    pendingWordSpace = false
  }

  const emit = (bytes: readonly number[]): void => {
    strings += 1
    const decoded = decodeWithFont(bytes, currentFont)
    if (decoded.unmapped) unmappedSources += 1
    out += decoded.text
    if (decoded.text !== '') lastCharIsSpace = false
  }

  /** 显示一个操作数：字符串直接显示；TJ 数组按项显示并在大间距处补空格。 */
  const showOperand = (operand: PdfOperand | undefined): void => {
    if (operand === undefined) return
    if (Array.isArray(operand)) {
      if (operand.length === 0) return
      if (isNumberArray(operand)) {
        emit(operand)
        return
      }
      for (const item of operand as TJItem[]) {
        if (item.kind === 'number') {
          // 负调整量够大 = 这里很可能是词间空格（PDF 没有空格字符，全靠字距）。
          if (Math.abs(item.value) > TJ_SPACE_THRESHOLD) pendingWordSpace = true
          continue
        }
        if (pendingWordSpace && !lastCharIsSpace) out += ' '
        pendingWordSpace = false
        emit(item.bytes)
      }
      return
    }
    if (typeof operand === 'string' || typeof operand === 'number') return
    emit(operand)
  }

  while (i < content.length) {
    const ch = content[i]!
    if (WHITESPACE.has(ch)) {
      i += 1
      continue
    }
    if (ch === '%') {
      const end = content.indexOf('\n', i)
      i = end === -1 ? content.length : end + 1
      continue
    }
    if (ch === '(') {
      const read = readPdfString(content, i)
      operands.push(read.bytes)
      i = read.next
      continue
    }
    if (ch === '<') {
      if (content[i + 1] === '<') {
        // 内联字典（如 BDC 的属性）：跳过整段
        let depth = 1
        i += 2
        while (i < content.length && depth > 0) {
          if (content.startsWith('<<', i)) { depth += 1; i += 2; continue }
          if (content.startsWith('>>', i)) { depth -= 1; i += 2; continue }
          if (content[i] === '(') { i = readPdfString(content, i).next; continue }
          i += 1
        }
        operands.length = 0
        continue
      }
      const end = content.indexOf('>', i)
      if (end === -1) break
      const hex = content.slice(i + 1, end).replace(/[^0-9a-fA-F]/g, '')
      const bytes: number[] = []
      for (let k = 0; k + 1 < hex.length; k += 2) bytes.push(Number.parseInt(hex.slice(k, k + 2), 16))
      if (hex.length % 2 === 1) bytes.push(Number.parseInt(`${hex.slice(-1)}0`, 16))
      operands.push(bytes)
      i = end + 1
      continue
    }
    if (ch === '[') {
      // 把整个数组当作**一个**操作数收集：TJ 的正文就是这个数组，
      // 里面是「字符串 / 数字」交替的项。
      // 用「头部匹配 + 截取数组正文」的写法，避免手写下标推进出错。
      i += 1
      const closeAt = findArrayEnd(content, i)
      const arrayBody = content.slice(i, closeAt === -1 ? content.length : closeAt)
      operands.push(parseArrayItems(arrayBody))
      i = closeAt === -1 ? content.length : closeAt + 1
      continue
    }
    if (ch === ']') {
      i += 1
      continue
    }
    if (ch === '/') {
      let end = i + 1
      while (end < content.length && !WHITESPACE.has(content[end]!) && !isDelimiter(content[end]!)) end += 1
      operands.push(content.slice(i + 1, end))
      i = end
      continue
    }
    if (ch === "'" || ch === '"') {
      // 单引号 = 换行 + 显示字符串；双引号 = 设置字/词间距 + 显示字符串。
      const last = operands[operands.length - 1]
      newline()
      showOperand(last)
      operands.length = 0
      i += 1
      continue
    }

    // 名字/数字/操作符
    let end = i
    while (end < content.length && !WHITESPACE.has(content[end]!) && !isDelimiter(content[end]!)) end += 1
    const token = content.slice(i, end)
    i = end === i ? i + 1 : end
    if (token === '') continue

    switch (token) {
      case 'BT':
        inText = true
        operands.length = 0
        newline()
        break
      case 'ET':
        inText = false
        operands.length = 0
        newline()
        break
      case 'Tf': {
        const name = operands.length >= 2 ? operands[operands.length - 2] : undefined
        if (typeof name === 'string') {
          currentFont = fonts.get(name) ?? fonts.get('*')
        }
        operands.length = 0
        break
      }
      case 'Tj':
      case "'":
      case '"': {
        const last = operands[operands.length - 1]
        if (token !== 'Tj') newline()
        showOperand(last)
        operands.length = 0
        break
      }
      case 'TJ': {
        showOperand(operands[operands.length - 1])
        operands.length = 0
        break
      }
      case 'Td':
      case 'TD':
      case 'T*':
        if (inText) newline()
        operands.length = 0
        break
      default:
        // 数字是操作数（字号/字距等），要留在栈上给后续操作符用；
        // 其他不认识的**操作符**才清栈，避免误配到后面的操作符。
        if (!/^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(token)) operands.length = 0
        else operands.push(Number(token))
        break
    }
    if (operands.length > 16) operands.length = 0
  }

  return {
    text: out.replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim(),
    strings,
    unmappedSources,
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

interface PdfRaw {
  readonly objects: readonly PdfObject[]
  readonly pageCount: number
  readonly contentStreams: readonly PdfObject[]
  readonly imageCount: number
  readonly hasFont: boolean
  readonly hasToUnicode: boolean
  readonly objectStreams: number
}

function parsePdf(objects: readonly PdfObject[]): PdfRaw {
  const objectStreams = objects.filter(object => isObjectStream(object.dict)).length
  const pageCount = objects.filter(object => object.kind === 'page').length
  const imageCount = objects.filter(object => /\/Subtype\s*\/Image\b/.test(object.dict)).length
  const hasFont = objects.some(object => /\/Type\s*\/Font\b/.test(object.dict))
  const hasToUnicode = objects.some(object => /\/ToUnicode\b/.test(object.dict))

  // 内容流：优先 /Type /Page 的 /Contents（含间接数组），其次"含文本操作符的流"。
  const contentStreams: PdfObject[] = []
  const wanted = new Set<number>()
  for (const object of objects) {
    if (object.kind !== 'page') continue
    for (const item of object.dict.matchAll(/\/Contents\s+(\d+)\s+\d+\s+R/g)) {
      wanted.add(Number.parseInt(item[1]!, 10))
    }
    const arrayText = /\/Contents\s*\[([^\]]*)\]/.exec(object.dict)?.[1]
    if (arrayText !== undefined) {
      for (const item of arrayText.matchAll(/(\d+)\s+\d+\s+R/g)) wanted.add(Number.parseInt(item[1]!, 10))
    }
  }
  if (wanted.size > 0) {
    for (const object of objects) {
      if (wanted.has(object.num)) contentStreams.push(object)
    }
  }

  const decodedStreams = new Map<number, Uint8Array>()
  for (const object of objects) {
    if (object.stream === undefined) continue
    if (object.kind === 'page') continue
    if (/\/Subtype\s*\/Image\b/.test(object.dict) || object.dict.includes('/FontFile')) continue
    const decoded = decodeStream(object.stream, object.dict)
    if (decoded !== undefined) decodedStreams.set(object.num, decoded)
  }

  if (contentStreams.length === 0) {
    for (const [num, data] of decodedStreams) {
      if (!looksLikeContentStream(bytesToLatin1(data))) continue
      const object = objects.find(candidate => candidate.num === num)
      if (object !== undefined) contentStreams.push(object)
    }
  }

  return {
    objects,
    pageCount: pageCount > 0 ? pageCount : Math.max(1, contentStreams.length),
    contentStreams,
    imageCount,
    hasFont,
    hasToUnicode,
    objectStreams,
  }
}

/** 内容流里出现文本操作符即认为是内容流（字体/图片程序几乎不会包含 `BT`+`Tj`）。 */
function looksLikeContentStream(text: string): boolean {
  return /\bBT\b/.test(text) || /\bTj\b/.test(text) || /\bTJ\b/.test(text)
}

/** 合法 Unicode 码位（排除代理区与超范围值）。 */
function validCodePoint(code: number): boolean {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return false
  return !(code >= 0xd800 && code <= 0xdfff)
}

/**
 * 把「被当作 latin1 读的字符串」按原字节尝试 UTF-8 还原。
 * 全部字节都能组成合法 UTF-8（且至少一个多字节序列）时返回还原结果，否则 undefined。
 * 用途：不少工具的 PDF 内容流写的是 UTF-8 字节，但字体没有 ToUnicode 表。
 */
function utf8FromLatin1(text: string): string | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  const bytes = new Uint8Array(trimmed.length)
  for (let i = 0; i < trimmed.length; i += 1) {
    const code = trimmed.charCodeAt(i)
    if (code > 0xff) return undefined
    bytes[i] = code
  }
  let out = ''
  let index = 0
  while (index < bytes.length) {
    const byte = bytes[index]!
    if (byte < 0x80) {
      out += String.fromCharCode(byte)
      index += 1
      continue
    }
    let needed = 0
    let code = 0
    if (byte >= 0xc2 && byte <= 0xdf) { needed = 1; code = byte & 0x1f }
    else if (byte >= 0xe0 && byte <= 0xef) { needed = 2; code = byte & 0x0f }
    else if (byte >= 0xf0 && byte <= 0xf4) { needed = 3; code = byte & 0x07 }
    else return undefined
    if (index + needed >= bytes.length) return undefined
    for (let k = 1; k <= needed; k += 1) {
      const next = bytes[index + k]!
      if (next < 0x80 || next > 0xbf) return undefined
      code = (code << 6) | (next & 0x3f)
    }
    index += needed + 1
    if (!validCodePoint(code)) return undefined
    if (code < 0x80 || (code >= 0xd800 && code <= 0xdfff)) return undefined
    out += String.fromCodePoint(code)
  }
  return out
}

/** 可打印字符占比（含中日韩文字、常见标点与空白）。 */
function printableRatio(text: string): number {
  const sample = text.length > 20000 ? text.slice(0, 20000) : text
  if (sample === '') return 0
  let good = 0
  for (const ch of sample) {
    const code = ch.codePointAt(0) ?? 0
    if (code === 9 || code === 10 || code === 13) { good += 1; continue }
    if (code >= 0x20 && code !== 0x7f) { good += 1; continue }
  }
  return good / sample.length
}

/**
 * 读取 PDF 文本（内部函数，返回空串表示抽不出来）。
 * 第二个返回值是提示信息。
 */
export function readPdfText(bytes: Uint8Array): { text: string; note?: string; lowConfidence: boolean; reason?: string; pages: number } {
  if (bytes.length === 0) return { text: '', lowConfidence: true, reason: '文件是空的。', pages: 0 }
  if (bytes.length > PDF_MAX_BYTES) {
    return { text: '', lowConfidence: true, reason: `PDF 有 ${bytes.length} 字节，超过 ${PDF_MAX_BYTES} 字节上限：请拆分或改用 .docx。`, pages: 0 }
  }
  const raw = bytesToLatin1(bytes)
  if (!raw.startsWith('%PDF-') && !raw.includes('%PDF-')) {
    return { text: '', lowConfidence: true, reason: '文件头不是 %PDF-：这不是 PDF 文件（可能扩展名被改过）。', pages: 0 }
  }
  if (/\/Encrypt\s+\d+\s+\d+\s+R|\/Encrypt\s*<</.test(raw)) {
    return { text: '', lowConfidence: true, reason: '这是加密（受密码保护）的 PDF：无法解析内容。请用阅读器另存为不含密码的 PDF，或直接提供 .docx/正文文本。', pages: 0 }
  }

  const objects = parseObjects(raw)
  if (objects.length === 0) {
    return { text: '', lowConfidence: true, reason: '这个 PDF 里找不到任何间接对象：文件已损坏，或使用了本模块不支持的交叉引用流结构。请用阅读器另存为 .docx 后重试。', pages: 0 }
  }

  const parsed = parsePdf(objects)

  const fonts = buildFontTables(raw, objects)
  const parts: string[] = []
  let strings = 0
  let unmapped = 0
  for (const object of parsed.contentStreams) {
    const decoded = object.stream !== undefined ? decodeStream(object.stream, object.dict) : undefined
    if (decoded === undefined) continue
    const content = bytesToLatin1(decoded)
    if (!/\bTj\b|\bTJ\b|\bBT\b/.test(content)) continue
    const extracted = extractContentText(content, fonts)
    strings += extracted.strings
    unmapped += extracted.unmappedSources
    if (extracted.text !== '') parts.push(extracted.text)
  }

  let text = parts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim()

  const notes: string[] = []
  if (parsed.objectStreams > 0) {
    notes.push(`该 PDF 含 ${parsed.objectStreams} 个对象流（Object Stream）：本模块不解析对象流，页面/字体信息可能不完整。`)
  }

  // CID 乱码清理：没有 CMap 的字体解出来的字节不可信，分三步判断
  // （结论都写进 note，不假装一定准确）：
  // ① 若字节序列本身就是合法 UTF-8（很多国产工具直接往内容流塞 UTF-8），忠实还原；
  // ② 否则看"可打印字符占比"，太低说明是 CID 码位 → 不返回乱码；
  // ③ 占比尚可 → 按 latin1 原样返回但标低置信。
  if (strings > 0 && unmapped / strings > 0.5) {
    const utf8Recovered = utf8FromLatin1(text)
    const printable = printableRatio(text)
    if (utf8Recovered !== undefined) {
      text = utf8Recovered
      notes.push('该 PDF 的字体缺 ToUnicode 映射，内容流实为 UTF-8 字节：已按 UTF-8 还原，个别字符仍可能有误，关键数据请核对原文。')
    } else if (printable < 0.5) {
      text = ''
      notes.push('该 PDF 使用嵌入子集字体（CID）且没有 ToUnicode 映射表，字节无法还原成字符——抽出来会是乱码，因此不返回内容。请提供 .docx 版本，或在阅读器里"另存为文本/复制正文"。')
    } else {
      notes.push('该 PDF 的字体缺少 ToUnicode 映射表，抽取结果可能有个别字符不准（已标低置信），关键内容请核对原文。')
    }
  }

  if (text === '') {
    const scanned = parsed.imageCount > 0 && !parsed.hasFont
    const reason = scanned
      ? '这看起来是扫描版/图片版 PDF（页面只有图片、没有文字层）：无法抽取文本。请提供 .docx，或用 OCR 工具转成文字后提供，也可以直接把正文复制成 .txt。'
      : parsed.imageCount > 0
        ? '这个 PDF 没有可抽取的文字内容（只有图片）：请在阅读器里复制正文，或提供 .docx 版本。'
        : '这个 PDF 里没有文字对象（可能是空文档，或结构不受支持）：请提供 .docx 版本。'
    return { text: '', lowConfidence: true, reason, pages: parsed.pageCount }
  }

  if (!parsed.hasToUnicode && parsed.hasFont) {
    notes.push('未发现 ToUnicode 映射表：中文/符号字体的字符可能有误，建议核对关键数据。')
  }

  const lowConfidence = text.length < LOW_CHARS && parsed.pageCount > LOW_PAGES
  if (lowConfidence) notes.push(`全文只有 ${text.length} 字符但页数 ${parsed.pageCount}：抽取率异常低，很可能大部分内容无法抽取，请自行核对。`)

  return {
    text,
    ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
    lowConfidence: lowConfidence || unmapped > 0,
    pages: parsed.pageCount,
  }
}

/** 门面用入口：pdf 字节 → 抽取结果。 */
export function extractPdf(bytes: Uint8Array, options: ExtractOptions): ExtractResult {
  let read: ReturnType<typeof readPdfText>
  try {
    read = readPdfText(bytes)
  } catch (error) {
    return failureResult(`解析 PDF 失败：${error instanceof Error ? error.message : String(error)}`)
  }
  if (read.reason !== undefined) {
    const detail = read.note !== undefined ? ` ${read.note}` : ''
    return failureResult(`${read.reason}${detail}`)
  }
  if (read.text.trim() === '') {
    return failureResult('未能从这个 PDF 中抽出任何文本：请提供 .docx 版本或正文文本。')
  }
  const { text, truncated } = truncateText(read.text, options.maxChars)
  const notes: string[] = [`共 ${read.pages} 页；PDF 文本按内容流顺序提取，表格/分栏顺序可能与肉眼不一致。`]
  if (read.note !== undefined) notes.push(read.note)
  if (truncated) notes.push(`内容超过 ${options.maxChars} 字符上限，已截断。`)
  return {
    ok: true,
    text,
    truncated,
    note: notes.join(' '),
    ...(read.lowConfidence ? { lowConfidence: true } : {}),
  }
}
