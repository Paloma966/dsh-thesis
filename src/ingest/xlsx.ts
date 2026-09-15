/**
 * `.xlsx` 摄取：每个工作表渲染成一段「表名 + 表头 + 行」的 TSV 文本。
 *
 * 需要处理的 OOXML 细节（都按"够用即止"实现，不做完整 SpreadsheetML）：
 * - `xl/workbook.xml` 给出 `<sheet name r:id>`；`xl/_rels/workbook.xml.rels`
 *   把 r:id 映射到 `worksheets/sheetN.xml`（两个文件都可能缺 rels，故有回退猜测）；
 * - `xl/sharedStrings.xml`：共享字符串表（`<si>` 可含多个 `<r><t>` 富文本片段）；
 * - 内联字符串 `t="inlineStr"`：值直接写在 `<is><t>` 里；
 * - 空单元格补空列：按 `<c r="C5">` 的列字母定位，缺列就用空串占位，保证列对齐；
 * - 日期：Excel 把日期存成序列号（如 45000）。本模块**原样保留数字**，
 *   但在表头行标注该列是「日期序列（Excel 序列号）」，避免把 45000 当数据。
 *
 * @module dsh-thesis/ingest
 */

import { failureResult, successResult, truncateText, type ExtractOptions, type ExtractResult } from './types.ts'
import { ZipError, decodeBytes, openZip } from './zip.ts'

/** 单表渲染配置：单表最长字符数（与 CLI 无关的硬上限，防超大表吃内存）。 */
const SHEET_CHAR_LIMIT = 200_000
/** 单表最多渲染的行数（超出即截断并标注）。 */
const SHEET_ROW_LIMIT = 5000

// ---------------------------------------------------------------------------
// 轻量 XML 取值
// ---------------------------------------------------------------------------

/** 取一个标签串里某个属性的值（值可用单/双引号，也可无引号）。 */
export function attr(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s/>]+))`).exec(tag)
  if (match === null) return undefined
  return match[1] ?? match[2] ?? match[3]
}

/** 取标签名 + 是否自闭合 + 属性串（供工作表遍历用）。 */
interface TagScan {
  readonly name: string
  readonly selfClosing: boolean
  /** 是否闭标签（`</row>`）。 */
  readonly closing: boolean
  readonly attrs: string
  /** 标签在源串中的起止下标（用于切出元素 body）。 */
  readonly start: number
  readonly end: number
}

const TAG_RE = /<(\/?)([A-Za-z_][\w.:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g

/** 按出现顺序扫描标签（不构建 DOM，只给位置与属性）。 */
export function scanTags(xml: string): TagScan[] {
  const out: TagScan[] = []
  TAG_RE.lastIndex = 0
  let match = TAG_RE.exec(xml)
  while (match !== null) {
    out.push({
      closing: match[1] === '/',
      name: match[2]!,
      attrs: match[3] ?? '',
      selfClosing: match[4] === '/',
      start: match.index,
      end: match.index + match[0].length,
    })
    match = TAG_RE.exec(xml)
  }
  return out
}

/** 标签短名（去掉可能存在的命名空间前缀）。 */
function shortName(name: string): string {
  const colon = name.lastIndexOf(':')
  return colon === -1 ? name : name.slice(colon + 1)
}

// ---------------------------------------------------------------------------
// workbook / rels
// ---------------------------------------------------------------------------

/** 从 `xl/workbook.xml` 抽工作表顺序与名字。 */
export function parseWorkbookSheets(workbookXml: string): Array<{ name: string; relId?: string }> {
  const sheets: Array<{ name: string; relId?: string }> = []
  const re = /<(?:\w+:)?sheet\b([^>]*?)(\/?)>/g
  let match = re.exec(workbookXml)
  while (match !== null) {
    const tag = match[1] ?? ''
    const relId = attr(tag, 'r:id') ?? attr(tag, 'id')
    const name = attr(tag, 'name') ?? `工作表${sheets.length + 1}`
    sheets.push({ name, ...(relId !== undefined ? { relId } : {}) })
    match = re.exec(workbookXml)
  }
  return sheets
}

/** 从 `xl/_rels/workbook.xml.rels` 抽 rId → 目标路径 的映射。 */
export function parseWorkbookRels(relsXml: string): Map<string, string> {
  const map = new Map<string, string>()
  const re = /<(?:\w+:)?Relationship\b([^>]*?)\/?>/g
  let match = re.exec(relsXml)
  while (match !== null) {
    const tag = match[1] ?? ''
    const id = attr(tag, 'Id')
    const target = attr(tag, 'Target')
    if (id !== undefined && target !== undefined) map.set(id, target)
    match = re.exec(relsXml)
  }
  return map
}

/** 把 rels 的 Target 归一到 ZIP 内的绝对路径。 */
function resolveTarget(target: string): string {
  let path = target.replace(/\\/g, '/')
  if (path.startsWith('/')) return path.slice(1)
  // 相对 `xl/workbook.xml` 解析（Target 常见写法是 "worksheets/sheet1.xml"）。
  const parts = `xl/${path}`.split('/')
  const out: string[] = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return out.join('/')
}

// ---------------------------------------------------------------------------
// sharedStrings / styles
// ---------------------------------------------------------------------------

/** 抽出一段 XML 里所有 `<t>` 的文本（`<si>` 的富文本片段拼接用）。 */
function collectText(xml: string): string {
  return collectTags(xml, 't')
}

/** 抽出一段 XML 里指定标签的文本（共享字符串用 `t`，单元格值用 `v`）。 */
function collectTags(xml: string, tag: string): string {
  let out = ''
  const re = new RegExp(`<(?:[\\w.-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${tag}>`, 'g')
  let match = re.exec(xml)
  while (match !== null) {
    out += decodeXmlLite(match[1] ?? '')
    match = re.exec(xml)
  }
  return out
}

/** 最小实体解码（xlsx 里出现的实体与 docx 相同；此处避免多一次 import 循环）。 */
function decodeXmlLite(input: string): string {
  return input
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (m, hex: string) => {
      const code = Number.parseInt(hex, 16)
      return code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : m
    })
    .replace(/&#([0-9]+);/g, (m, dec: string) => {
      const code = Number.parseInt(dec, 10)
      return code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : m
    })
    .replace(/&amp;/g, '&')
}

/** 解析 `xl/sharedStrings.xml`：索引 → 文本。 */
export function parseSharedStrings(xml: string): string[] {
  const items: string[] = []
  const re = /<(?:[\w.-]+:)?si(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w.-]+:)?si>/g
  let match = re.exec(xml)
  while (match !== null) {
    items.push(collectText(match[1] ?? ''))
    match = re.exec(xml)
  }
  return items
}

/** 内置的日期/时间数字格式 id（ECMA-376 第 18 章）。 */
const BUILTIN_DATE_FORMATS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36,
  45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58,
])

/** 自定义格式串是否像日期/时间（去掉引号、转义、颜色/条件段后看 ymdhs 字符）。 */
export function isDateFormatCode(code: string): boolean {
  const cleaned = code
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\\./g, '')
    .replace(/"[^"]*"/g, '')
  // 去掉第 4 段（条件/颜色）之前的处理已够；这里只看是否含日期时间占位符。
  return /[ymdhs]/i.test(cleaned) && !/^[#0.,%]+$/.test(cleaned)
}

/**
 * 解析 `xl/styles.xml`：返回「cellXfs 下标 → 是否日期格式」。
 * 有些工具不写 cellXfs（此时全按非日期处理，数值原样保留）。
 */
export function parseStyleDateFlags(stylesXml: string | undefined): boolean[] {
  if (stylesXml === undefined) return []
  const custom = new Map<number, boolean>()
  const fmtRe = /<(?:\w+:)?numFmt\b([^>]*?)\/?>/g
  let match = fmtRe.exec(stylesXml)
  while (match !== null) {
    const tag = match[1] ?? ''
    const id = Number.parseInt(attr(tag, 'numFmtId') ?? '', 10)
    const code = attr(tag, 'formatCode')
    if (Number.isFinite(id) && code !== undefined) custom.set(id, isDateFormatCode(code))
    match = fmtRe.exec(stylesXml)
  }

  const cellXfsMatch = /<(?:\w+:)?cellXfs\b[^>]*>([\s\S]*?)<\/(?:\w+:)?cellXfs>/.exec(stylesXml)
  if (cellXfsMatch === null) return []
  const flags: boolean[] = []
  const xfRe = /<(?:\w+:)?xf\b([^>]*?)\/?>/g
  let xf = xfRe.exec(cellXfsMatch[1] ?? '')
  while (xf !== null) {
    const tag = xf[1] ?? ''
    const id = Number.parseInt(attr(tag, 'numFmtId') ?? '0', 10)
    const isDate = custom.get(id) ?? BUILTIN_DATE_FORMATS.has(id)
    flags.push(isDate)
    xf = xfRe.exec(cellXfsMatch[1] ?? '')
  }
  return flags
}

// ---------------------------------------------------------------------------
// 单元格引用
// ---------------------------------------------------------------------------

/** `C12` → 列下标 2（0 基）；非法引用返回 0。 */
export function columnIndex(ref: string): number {
  let index = 0
  let seen = false
  for (let i = 0; i < ref.length; i += 1) {
    const code = ref.charCodeAt(i)
    const upper = code >= 97 && code <= 122 ? code - 32 : code
    if (upper < 65 || upper > 90) break
    index = index * 26 + (upper - 64)
    seen = true
  }
  return seen ? index - 1 : 0
}

// ---------------------------------------------------------------------------
// 单表渲染
// ---------------------------------------------------------------------------

interface CellValue {
  readonly kind: 'text' | 'number' | 'date'
  readonly text: string
}

/** 解析一行里的单元格。 */
export function parseRow(rowXml: string, shared: readonly string[], dateFlags: readonly boolean[]): CellValue[] {
  const cells: CellValue[] = []
  // 逐标签扫描（正则匹配"属性 + 开/闭标签"容易在自闭合标签上出错）：
  // 每遇到一个 <c> 就取它的属性串，再用下一个标签的结束位置切出 body。
  const tags = scanTags(rowXml)
  for (const [index, tag] of tags.entries()) {
    if (shortName(tag.name) !== 'c' || tag.closing) continue
    const ref = attr(tag.attrs, 'r') ?? ''
    const column = columnIndex(ref)
    while (cells.length < column) cells.push({ kind: 'text', text: '' })

    // body = 开标签结束 → **配对**闭标签开始（单元格内还有 <v>/<is> 等子标签，
    // 不能只看"下一个标签"）；自闭合或找不到配对闭标签时视为空。
    let body = ''
    if (!tag.selfClosing) {
      let depth = 0
      for (let k = index + 1; k < tags.length; k += 1) {
        const candidate = tags[k]!
        if (!candidate.closing) {
          if (!candidate.selfClosing && shortName(candidate.name) === 'c') depth += 1
          continue
        }
        if (shortName(candidate.name) !== 'c') continue
        if (depth > 0) {
          depth -= 1
          continue
        }
        body = rowXml.slice(tag.end, candidate.start)
        break
      }
    }

    const type = attr(tag.attrs, 't') ?? 'n'
    const styleIndex = Number.parseInt(attr(tag.attrs, 's') ?? '', 10)
    const isDate = Number.isFinite(styleIndex) && dateFlags[styleIndex] === true

    let value: CellValue
    if (type === 'inlineStr') {
      value = { kind: 'text', text: collectText(body) }
    } else if (type === 's') {
      const sharedIndex = Number.parseInt(collectTags(body, 'v').trim(), 10)
      value = { kind: 'text', text: Number.isFinite(sharedIndex) ? shared[sharedIndex] ?? '' : '' }
    } else if (type === 'b') {
      value = { kind: 'text', text: collectTags(body, 'v').trim() === '1' ? 'TRUE' : 'FALSE' }
    } else if (type === 'str') {
      value = { kind: 'text', text: collectTags(body, 'v') }
    } else {
      const raw = collectTags(body, 'v').trim()
      value = { kind: isDate && raw !== '' ? 'date' : 'number', text: raw }
    }
    cells.length = column
    cells.push(value)
  }
  return cells
}

/** 把一行单元格渲染成 TSV（空单元格补空列，保证对齐）。 */
function renderRow(cells: readonly CellValue[]): string {
  const parts: string[] = []
  for (const cell of cells) {
    // 值里的制表符/换行会破坏 TSV 对齐：换成空格。
    parts.push(cell.text.replace(/[\t\r\n]+/g, ' ').trim())
  }
  return parts.join('\t')
}

interface SheetRender {
  readonly text: string
  readonly rows: number
  readonly truncated: boolean
  readonly truncatedRows: boolean
}

/** 渲染一个工作表：表名 + 表头 + TSV 行。 */
export function renderSheet(name: string, sheetXml: string, shared: readonly string[], dateFlags: readonly boolean[]): SheetRender {
  const rowRe = /<(?:[\w.-]+:)?row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?row>)/g
  let match = rowRe.exec(sheetXml)
  const lines: string[] = []
  const dateColumns = new Set<number>()
  let dataRows = 0
  let first = true
  let truncatedRows = false
  while (match !== null) {
    const body = match[2] ?? ''
    const cells = parseRow(body, shared, dateFlags)
    if (cells.some(cell => cell.text.trim() !== '')) {
      if (dataRows >= SHEET_ROW_LIMIT) {
        truncatedRows = true
        break
      }
      dataRows += 1
      if (!first) {
        for (let i = 0; i < cells.length; i += 1) {
          if (cells[i]!.kind === 'date') dateColumns.add(i)
        }
      }
      lines.push(renderRow(cells))
      first = false
    }
    match = rowRe.exec(sheetXml)
  }

  const hints: string[] = []
  if (dateColumns.size > 0) {
    const letters = [...dateColumns].sort((a, b) => a - b).map(i => `第 ${i + 1} 列`)
    hints.push(`列类型提示：${letters.join('、')}为日期列，值保留为 Excel 序列号（如 45000 表示某天，需自行换算）。`)
  }
  if (truncatedRows) hints.push(`该表超过 ${SHEET_ROW_LIMIT} 行，只渲染前 ${SHEET_ROW_LIMIT} 行。`)

  const header = [
    `## 工作表：${name}`,
    `（共 ${dataRows} 行非空数据）`,
    ...hints,
    '',
  ].join('\n')
  const body = lines.join('\n')
  const whole = `${header}${body}\n`
  const limited = truncateText(whole, SHEET_CHAR_LIMIT)
  return { text: limited.text, rows: dataRows, truncated: limited.truncated, truncatedRows }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/** 读取一个 .xlsx：返回按工作表顺序渲染的 TSV 文本。 */
export function readXlsx(bytes: Uint8Array): { text: string; sheets: number } {
  const zip = openZip(bytes)
  const workbookBytes = zip.read('xl/workbook.xml')
  if (workbookBytes === undefined) {
    throw new ZipError('missing-workbook', '这个 ZIP 里没有 xl/workbook.xml：不是有效的 .xlsx（可能是 .ods 或已损坏）。请用 Excel/WPS 另存为 .xlsx。')
  }
  const workbookXml = decodeBytes(workbookBytes)
  const sheets = parseWorkbookSheets(workbookXml)
  if (sheets.length === 0) {
    throw new ZipError('no-sheets', '工作簿里没有任何工作表：无法抽取内容。')
  }

  const relsBytes = zip.read('xl/_rels/workbook.xml.rels')
  const rels = relsBytes !== undefined ? parseWorkbookRels(decodeBytes(relsBytes)) : new Map<string, string>()

  const sharedBytes = zip.read('xl/sharedStrings.xml')
  const shared = sharedBytes !== undefined ? parseSharedStrings(decodeBytes(sharedBytes)) : []

  const stylesBytes = zip.read('xl/styles.xml')
  const dateFlags = parseStyleDateFlags(stylesBytes !== undefined ? decodeBytes(stylesBytes) : undefined)

  const blocks: string[] = []
  let rendered = 0
  for (const [index, sheet] of sheets.entries()) {
    const candidates: string[] = []
    const target = sheet.relId !== undefined ? rels.get(sheet.relId) : undefined
    if (target !== undefined) candidates.push(resolveTarget(target))
    candidates.push(`xl/worksheets/sheet${index + 1}.xml`)
    // 有些工具把表放在别的目录，或 rels 与文件名不一致：按出现顺序兜底找。
    const available = zip.names('xl/', '.xml')
    for (const candidate of available) {
      if (/^xl\/worksheets\/[^/]+\.xml$/.test(candidate) && !candidates.includes(candidate)) candidates.push(candidate)
    }
    const path = candidates.find(candidate => zip.has(candidate))
    if (path === undefined) {
      blocks.push(`## 工作表：${sheet.name}\n（未找到该表的 XML 数据，可能被删除或使用了非常规结构）\n`)
      continue
    }
    const renderedSheet = renderSheet(sheet.name, decodeBytes(zip.require(path)), shared, dateFlags)
    blocks.push(renderedSheet.text)
    rendered += 1
  }

  return { text: blocks.join('\n'), sheets: rendered }
}

/** 门面用入口：xlsx 字节 → 抽取结果。 */
export function extractXlsx(bytes: Uint8Array, options: ExtractOptions): ExtractResult {
  let read: { text: string; sheets: number }
  try {
    read = readXlsx(bytes)
  } catch (error) {
    const reason = error instanceof ZipError
      ? error.message
      : `读取 .xlsx 失败：${error instanceof Error ? error.message : String(error)}`
    return failureResult(reason)
  }
  if (!hasAnyData(read.text)) {
    return failureResult('这个 .xlsx 的所有工作表都是空的：没有可摄取的数据。')
  }
  return successResult({
    text: read.text,
    maxChars: options.maxChars,
    note: `共 ${read.sheets} 个工作表；表内空单元格已补空列，列对齐可保，但公式只保留缓存值。`,
  })
}

/** 工作表是否有任何非空数据行（供"空工作簿"判定）。 */
export function hasAnyData(text: string): boolean {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    if (trimmed.startsWith('（') || trimmed.startsWith('列类型提示')) continue
    if (trimmed.replace(/\t/g, '') !== '') return true
  }
  return false
}
