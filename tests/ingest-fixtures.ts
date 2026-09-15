/**
 * 摄取模块的测试夹具（**只在测试里用，不进仓库的二进制夹具**）：
 *
 * - `buildTestZip`：纯代码构造合法 ZIP（STORE 或 DEFLATE，`deflateRawSync` 压缩），
 *   用来喂 `src/ingest/zip.ts`，两条解压路径都能验证；
 * - `buildDocx` / `buildXlsx` / `buildPptx` / `buildUncompressedPdf`：用上述 ZIP
 *   或纯字节拼出结构合法的最小 OOXML/PDF 文档；
 * - `FakeFs`：内存 FileSystem（stat/listDir 支持目录），验证 `thesis_ingest` 落盘；
 * - `FakeIO`：内存 IngestIO，替代 node:fs 读文件。
 */

import { deflateRawSync } from 'node:zlib'
import * as nodePath from 'node:path'
import type { FileSystem, FsDirEntry, FsInfo, FsTarget } from '@deepseek-ai/dsh-fs'
import type { IngestFile, IngestIO } from '../src/ingest/index.ts'

const encoder = new TextEncoder()

// ---------------------------------------------------------------------------
// ZIP 构造（与 src/paper/lib/zip.ts 同思路，独立实现，供测试对照）
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(data: Uint8Array): number {
  let c = 0xffffffff
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function u16(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff]
}

function u32(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** 构造一个 ZIP；`deflate: true` 的条目用 DEFLATE（method 8），否则 STORE（method 0）。 */
export function buildTestZip(
  entries: ReadonlyArray<{ name: string; text?: string; bytes?: Uint8Array; deflate?: boolean }>,
): Uint8Array {
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0
  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name)
    const raw = entry.bytes ?? encoder.encode(entry.text ?? '')
    const useDeflate = entry.deflate === true
    const data = useDeflate ? new Uint8Array(deflateRawSync(raw)) : raw
    const crc = crc32(raw)
    const local = new Uint8Array([
      ...u32(0x04034b50),
      ...u16(20),
      ...u16(0x0800), // UTF-8 名称
      ...u16(useDeflate ? 8 : 0),
      ...u16(0), ...u16(0),
      ...u32(crc),
      ...u32(data.length),
      ...u32(raw.length),
      ...u16(nameBytes.length),
      ...u16(0),
      ...nameBytes,
      ...data,
    ])
    locals.push(local)
    centrals.push(new Uint8Array([
      ...u32(0x02014b50),
      ...u16(20), ...u16(20),
      ...u16(0x0800),
      ...u16(useDeflate ? 8 : 0),
      ...u16(0), ...u16(0),
      ...u32(crc),
      ...u32(data.length),
      ...u32(raw.length),
      ...u16(nameBytes.length),
      ...u16(0), ...u16(0), ...u16(0),
      ...u16(0),
      ...u32(0),
      ...u32(offset),
      ...nameBytes,
    ]))
    offset += local.length
  }
  const central = concat(centrals)
  const eocd = new Uint8Array([
    ...u32(0x06054b50),
    ...u16(0), ...u16(0),
    ...u16(entries.length), ...u16(entries.length),
    ...u32(central.length),
    ...u32(offset),
    ...u16(0),
  ])
  return concat([...locals, central, eocd])
}

// ---------------------------------------------------------------------------
// OOXML 片段
// ---------------------------------------------------------------------------

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** 一个 `<w:p>`（可含多个 run；`instrText` 用于造域代码）。 */
export function docxParagraph(parts: ReadonlyArray<string | { instrText: string }>): string {
  const runs = parts.map(part => typeof part === 'string'
    ? `<w:r><w:t xml:space="preserve">${escapeXml(part)}</w:t></w:r>`
    : `<w:r><w:instrText>${escapeXml(part.instrText)}</w:instrText></w:r>`)
  return `<w:p>${runs.join('')}</w:p>`
}

export interface DocxSpec {
  readonly paragraphs: readonly string[]
  /** 表格：每行是若干单元格文本。 */
  readonly table?: ReadonlyArray<readonly string[]>
  /** `docProps/core.xml` 里的 dc:title。 */
  readonly title?: string
}

/** 构造一个结构合法（STORE）的最小 .docx。 */
export function buildDocx(spec: DocxSpec): Uint8Array {
  const body: string[] = []
  for (const paragraph of spec.paragraphs) body.push(`<w:p><w:r><w:t xml:space="preserve">${escapeXml(paragraph)}</w:t></w:r></w:p>`)
  if (spec.table !== undefined) {
    const rows = spec.table.map(row => `<w:tr>${row.map(cell => `<w:tc><w:p><w:r><w:t>${escapeXml(cell)}</w:t></w:r></w:p></w:tc>`).join('')}</w:tr>`)
    body.push(`<w:tbl>${rows.join('')}</w:tbl>`)
  }
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join('')}<w:sectPr/></w:body></w:document>`
  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${escapeXml(spec.title ?? '')}</dc:title></cp:coreProperties>`
  return buildTestZip([
    { name: '[Content_Types].xml', text: '<?xml version="1.0"?><Types/>' },
    { name: '_rels/.rels', text: '<?xml version="1.0"?><Relationships/>' },
    ...(spec.title !== undefined ? [{ name: 'docProps/core.xml', text: core }] : []),
    { name: 'word/document.xml', text: document },
  ])
}

export interface XlsxSheetSpec {
  readonly name: string
  readonly rows: ReadonlyArray<ReadonlyArray<{ ref?: string; value: string; type?: 'number' | 'shared' | 'inline' | 'boolean'; style?: number }>>
}

export interface XlsxSpec {
  readonly sheets: readonly XlsxSheetSpec[]
  /** 共享字符串表；`type: 'shared'` 的单元格 value 是这里的下标。 */
  readonly sharedStrings?: readonly string[]
  /** 日期格式的样式下标（写进 styles.xml 的 cellXfs）。 */
  readonly dateStyles?: readonly number[]
}

/** 构造一个结构合法（STORE）的最小 .xlsx。 */
export function buildXlsx(spec: XlsxSpec): Uint8Array {
  const sheetEntries = spec.sheets.map((sheet, index) => ({ name: `xl/worksheets/sheet${index + 1}.xml`, text: sheetXml(sheet) }))
  const workbookSheets = spec.sheets
    .map((sheet, index) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`)
    .join('')
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${workbookSheets}</sheets></workbook>`
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${spec.sheets
    .map((_sheet, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`)
    .join('')}</Relationships>`

  const styles = buildStyles(spec.dateStyles ?? [])
  const shared = spec.sharedStrings === undefined
    ? []
    : [{
        name: 'xl/sharedStrings.xml',
        text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${spec.sharedStrings.length}" uniqueCount="${spec.sharedStrings.length}">${spec.sharedStrings
          .map(item => `<si><t>${escapeXml(item)}</t></si>`)
          .join('')}</sst>`,
      }]

  return buildTestZip([
    { name: '[Content_Types].xml', text: '<?xml version="1.0"?><Types/>' },
    { name: '_rels/.rels', text: '<?xml version="1.0"?><Relationships/>' },
    { name: 'xl/workbook.xml', text: workbook },
    { name: 'xl/_rels/workbook.xml.rels', text: rels },
    { name: 'xl/styles.xml', text: styles },
    ...shared,
    ...sheetEntries,
  ])
}

function buildStyles(dateStyles: readonly number[]): string {
  const xfs = dateStyles.map(index => `<xf numFmtId="14" fontId="0" fillId="0" borderId="0" applyNumberFormat="1" xfId="0"/>`)
  const padding = Math.max(0, 2 - xfs.length)
  const all = [...xfs, ...Array.from({ length: padding }, () => '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>')]
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font/></fonts><fills count="1"><fill/></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0"/></cellStyleXfs><cellXfs count="${all.length}">${all.join('')}</cellXfs></styleSheet>`
}

function sheetXml(sheet: XlsxSheetSpec): string {
  const rows = sheet.rows.map((row, rowIndex) => {
    const cells = row.map((cell, columnIndex) => {
      const ref = cell.ref ?? `${columnName(columnIndex)}${rowIndex + 1}`
      const style = cell.style !== undefined ? ` s="${cell.style}"` : ''
      if (cell.type === 'shared') return `<c r="${ref}"${style} t="s"><v>${escapeXml(cell.value)}</v></c>`
      if (cell.type === 'inline') return `<c r="${ref}"${style} t="inlineStr"><is><t>${escapeXml(cell.value)}</t></is></c>`
      if (cell.type === 'boolean') return `<c r="${ref}"${style} t="b"><v>${escapeXml(cell.value)}</v></c>`
      return `<c r="${ref}"${style}><v>${escapeXml(cell.value)}</v></c>`
    })
    return `<row r="${rowIndex + 1}">${cells.join('')}</row>`
  }).join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`
}

function columnName(index: number): string {
  let name = ''
  let value = index
  while (value >= 0) {
    name = String.fromCharCode(65 + (value % 26)) + name
    value = Math.floor(value / 26) - 1
  }
  return name
}

/** 构造一个结构合法（STORE）的最小 .pptx；每页给若干段落。 */
export function buildPptx(slides: ReadonlyArray<readonly string[]>, title?: string): Uint8Array {
  const entries: Array<{ name: string; text: string }> = [
    { name: '[Content_Types].xml', text: '<?xml version="1.0"?><Types/>' },
    { name: '_rels/.rels', text: '<?xml version="1.0"?><Relationships/>' },
    {
      name: 'ppt/presentation.xml',
      text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">${slides
        .map((_slide, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 1}"/>`)
        .join('')}</p:presentation>`,
    },
  ]
  if (title !== undefined) {
    entries.push({
      name: 'docProps/core.xml',
      text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${escapeXml(title)}</dc:title></cp:coreProperties>`,
    })
  }
  slides.forEach((paragraphs, index) => {
    const body = paragraphs.map(paragraph => `<a:p><a:r><a:t>${escapeXml(paragraph)}</a:t></a:r></a:p>`).join('')
    entries.push({
      name: `ppt/slides/slide${index + 1}.xml`,
      text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>${body}</p:spTree></p:cSld></p:sld>`,
    })
  })
  return buildTestZip(entries)
}

/** 压缩（DEFLATE）版 docx：验证 ZIP method 8 路径。 */
export function buildDeflatedDocx(texts: readonly string[]): Uint8Array {
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${texts
    .map(text => `<w:p><w:r><w:t>${escapeXml(text)}</w:t></w:r></w:p>`)
    .join('')}</w:body></w:document>`
  return buildTestZip([{ name: 'word/document.xml', text: document, deflate: true }])
}

// ---------------------------------------------------------------------------
// PDF 构造（手工拼字节 + 正确的 xref 偏移，故 pdf.ts 的偏移路径也走得到）
// ---------------------------------------------------------------------------

export interface PdfSpec {
  /** 每页的文本行。 */
  readonly pages: ReadonlyArray<readonly string[]>
  /** 直接用给定的内容流文本（覆盖 pages；用于 ToUnicode / 转义测试）。 */
  readonly contentLines?: readonly string[]
  /** 是否用 FlateDecode 压缩内容流。 */
  readonly deflate?: boolean
  /** 是否有 /Encrypt 字典（加密 PDF 的诚实失败路径）。 */
  readonly encrypted?: boolean
  /** 是否加一个图片 XObject（模拟扫描版）。 */
  readonly image?: boolean
  /** 是否给字体加 ToUnicode CMap（中文/CID 场景）。 */
  readonly toUnicode?: boolean
}

export interface PdfFixture {
  readonly bytes: Uint8Array
  /** 每页一个内容流（供篡改/损坏测试）。 */
  readonly contentByPage: readonly Uint8Array[]
  /** 第一个内容流在文件里的偏移（供损坏测试）。 */
  readonly firstContentOffset: number
  /** 每页内容流在文件里的偏移。 */
  readonly contentOffsets: readonly number[]
}

/**
 * 构造一个最小但结构合法的 PDF：
 * 目录 → 页 → 内容流（可选 FlateDecode）→ 字体（可选 ToUnicode）→ xref → trailer。
 */
export function buildPdf(spec: PdfSpec): PdfFixture {
  const objects = new Map<number, Uint8Array>()
  const pageNumbers: number[] = []
  const contentByPage: Uint8Array[] = []
  const contentNumbers: number[] = []

  const nPages = spec.pages.length
  const fontObjNum = 3
  const cmapObjNum = 4
  let next = 5
  for (let i = 0; i < nPages; i += 1) {
    pageNumbers.push(next)
    next += 1
    contentNumbers.push(next)
    next += 1
  }
  const pagesObjNum = next
  const catalogObjNum = next + 1
  const imageNum = catalogObjNum + 1

  const fontDict = spec.toUnicode
    ? `<< /Type /Font /Subtype /Type0 /BaseFont /Test /Encoding /Identity-H /DescendantFonts [] /ToUnicode ${cmapObjNum} 0 R >>`
    : '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'
  objects.set(fontObjNum, encoder.encode(fontDict))

  if (spec.toUnicode) {
    // 覆盖 ASCII：<01> → U+0041（"A"），并给一个中文码位 <4E2D> → 中。
    const cmap = `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
2 beginbfchar
<0041> <0041>
<4E2D> <4E2D>
endbfchar
endcmap
end
end`
    const cmapBytes = encoder.encode(cmap)
    objects.set(cmapObjNum, concat([
      encoder.encode(`<< /Length ${cmapBytes.length} >>\nstream\n`),
      cmapBytes,
      encoder.encode('\nendstream'),
    ]))
  }

  spec.pages.forEach((lines, index) => {
    const content = spec.contentLines?.[index]
      ?? `BT /F1 12 Tf 72 720 Td (${lines.join(') Tj T* (')}) Tj ET`
    const raw = encoder.encode(content)
    const stream = spec.deflate === true ? new Uint8Array(deflateRawSync(raw)) : raw
    contentByPage.push(stream)
    const dict = `<< /Length ${stream.length}${spec.deflate === true ? ' /Filter /FlateDecode' : ''} >>\nstream\n`
    const tail = '\nendstream'
    objects.set(contentNumbers[index]!, concat([encoder.encode(dict), stream, encoder.encode(tail)]))
  })

  spec.pages.forEach((_lines, index) => {
    const xobjects = spec.image === true ? ` /XObject << /Im0 ${imageNum} 0 R >>` : ''
    const pageDict = `<< /Type /Page /Parent ${pagesObjNum} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObjNum} 0 R >>${xobjects} >> /Contents ${contentNumbers[index]} 0 R >>`
    objects.set(pageNumbers[index]!, encoder.encode(pageDict))
  })

  const kids = pageNumbers.map(number => `${number} 0 R`).join(' ')
  objects.set(pagesObjNum, encoder.encode(`<< /Type /Pages /Kids [${kids}] /Count ${nPages} >>`))
  objects.set(catalogObjNum, encoder.encode(`<< /Type /Catalog /Pages ${pagesObjNum} 0 R >>`))
  if (spec.image === true) {
    const imageData = new Uint8Array([0xff, 0xd8, 0xff, 0xd9])
    objects.set(imageNum, concat([
      encoder.encode(`<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${imageData.length} >>\nstream\n`),
      imageData,
      encoder.encode('\nendstream'),
    ]))
  }

  // 按对象号顺序序列化，记录偏移
  const parts: Uint8Array[] = [encoder.encode('%PDF-1.4\n')]
  let offset = parts[0]!.length
  const offsets = new Map<number, number>()
  const maxObject = Math.max(...objects.keys())
  for (let number = 1; number <= maxObject; number += 1) {
    const body = objects.get(number)
    if (body === undefined) continue
    offsets.set(number, offset)
    const prefix = encoder.encode(`${number} 0 obj\n`)
    const suffix = encoder.encode('\nendobj\n')
    parts.push(prefix, body, suffix)
    offset += prefix.length + body.length + suffix.length
  }
  const xrefOffset = offset
  const extra = spec.encrypted === true ? ' /Encrypt << /Filter /Standard /V 2 /R 3 /O (x) /U (y) /P -1 >>' : ''
  const xrefLines: string[] = [`xref`, `0 ${maxObject + 1}`, '0000000000 65535 f ']
  for (let number = 1; number <= maxObject; number += 1) {
    const found = offsets.get(number)
    xrefLines.push(found === undefined ? '0000000000 65535 f ' : `${String(found).padStart(10, '0')} 00000 n `)
  }
  const trailer = `trailer\n<< /Size ${maxObject + 1} /Root ${catalogObjNum} 0 R${extra} >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  parts.push(encoder.encode(`${xrefLines.join('\n')}\n${trailer}`))

  const bytes = concat(parts)
  // 内容流偏移（文件内的绝对位置）
  const contentOffsets: number[] = []
  const text = new TextDecoder('latin1').decode(bytes)
  for (const stream of contentByPage) {
    // 用 stream 的字节内容在文件里定位（内容唯一，够用）
    const needle = new TextDecoder('latin1').decode(stream)
    contentOffsets.push(text.indexOf(needle))
  }
  return {
    bytes,
    contentByPage,
    firstContentOffset: contentOffsets[0] ?? 0,
    contentOffsets,
  }
}

// ---------------------------------------------------------------------------
// 内存 FileSystem / IngestIO
// ---------------------------------------------------------------------------

/** 测试用内存文件系统：支持目录、stat、listDir，写入自动建父目录。 */
export class FakeFs implements FileSystem {
  private readonly files = new Map<string, string>()
  private readonly dirs = new Set<string>()

  private key(p: string): string {
    // 与生产代码一致地解析绝对路径（Windows 上 /thesis → C:\thesis）。
    return nodePath.resolve(p)
  }

  /** 直接塞一个文件（测试准备用）。 */
  seed(path: string, content: string): void {
    const key = this.key(path)
    this.files.set(key, content)
    this.registerParents(key)
  }

  peek(path: string): string | undefined {
    return this.files.get(this.key(path))
  }

  get paths(): string[] {
    return [...this.files.keys()]
  }

  private registerParents(key: string): void {
    let dir = nodePath.dirname(key)
    while (dir !== nodePath.dirname(dir)) {
      this.dirs.add(dir)
      dir = nodePath.dirname(dir)
    }
    this.dirs.add(dir)
  }

  async resolve(path: string, _opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    return { displayPath: path }
  }

  async readText(target: FsTarget, _signal?: AbortSignal): Promise<string> {
    const content = this.files.get(this.key(target.displayPath))
    if (content === undefined) throw new Error(`ENOENT: ${target.displayPath}`)
    return content
  }

  async writeText(target: FsTarget, content: string, _expected?: unknown, _signal?: AbortSignal): Promise<{ version?: unknown }> {
    const key = this.key(target.displayPath)
    this.files.set(key, content)
    this.registerParents(key)
    return { version: 1 }
  }

  async listDir(target: FsTarget, _signal?: AbortSignal): Promise<FsDirEntry[]> {
    const dir = this.key(target.displayPath)
    if (!this.dirs.has(dir) && !this.files.has(dir)) throw new Error(`ENOENT: ${dir}`)
    const entries: FsDirEntry[] = []
    const seen = new Set<string>()
    for (const key of this.files.keys()) {
      if (!key.startsWith(dir + nodePath.sep)) continue
      const rest = key.slice(dir.length + 1)
      const name = rest.split(nodePath.sep)[0]!
      if (seen.has(name)) continue
      seen.add(name)
      const isDirectory = rest.includes(nodePath.sep)
      entries.push({ name, isDirectory })
    }
    return entries
  }

  async stat(target: FsTarget, _signal?: AbortSignal): Promise<FsInfo | undefined> {
    const key = this.key(target.displayPath)
    if (this.files.has(key)) return { isDirectory: false, size: this.files.get(key)!.length }
    if (this.dirs.has(key)) return { isDirectory: true, size: 0 }
    return undefined
  }
}

/** 内存 IngestIO：把「路径 → 字节」映射成可灌注的文件树。 */
export class FakeIO implements IngestIO {
  private readonly entries = new Map<string, Uint8Array>()
  private readonly roots = new Set<string>()

  private key(p: string): string {
    return nodePath.resolve(p)
  }

  /** 注册一个文件（自动登记其所有父目录）。 */
  add(path: string, bytes: Uint8Array | string): IngestFile {
    const key = this.key(path)
    const data = typeof bytes === 'string' ? encoder.encode(bytes) : bytes
    this.entries.set(key, data)
    let dir = nodePath.dirname(key)
    while (true) {
      this.roots.add(dir)
      const parent = nodePath.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    return { absolute: key, size: data.length, rel: nodePath.basename(key) }
  }

  async kind(target: string): Promise<'file' | 'dir' | undefined> {
    const key = this.key(target)
    if (this.entries.has(key)) return 'file'
    if (this.roots.has(key)) return 'dir'
    return undefined
  }

  async list(target: string): Promise<readonly { name: string; isDirectory: boolean }[]> {
    const dir = this.key(target)
    if (!this.roots.has(dir)) throw new Error(`ENOENT: ${dir}`)
    const out: Array<{ name: string; isDirectory: boolean }> = []
    const seen = new Set<string>()
    for (const key of this.entries.keys()) {
      if (!key.startsWith(dir + nodePath.sep)) continue
      const rest = key.slice(dir.length + 1)
      const name = rest.split(nodePath.sep)[0]!
      if (seen.has(name)) continue
      seen.add(name)
      out.push({ name, isDirectory: rest.includes(nodePath.sep) })
    }
    return out
  }

  async read(target: string): Promise<Uint8Array> {
    const data = this.entries.get(this.key(target))
    if (data === undefined) throw new Error(`ENOENT: ${target}`)
    return data
  }
}
