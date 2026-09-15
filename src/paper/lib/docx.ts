/**
 * 零依赖 .docx 生成：Markdown-lite → WordprocessingML。
 *
 * 覆盖论文写作实际用到的 Markdown 子集：
 * - 标题 # / ## / ###（H1 每章另起一页）
 * - 段落、粗体 **text**、行内代码 `code`、链接 [text](url)
 * - 无序列表 - item、表格 | a | b |
 * - G2 清单 - [ ] / - [x] 保持为列表项文本
 *
 * 中文排版：正文宋体 + Times New Roman、1.5 倍行距；标题黑体。
 * 这是内置过渡引擎；机器装有 pandoc 时 thesis_build 优先走 pandoc。
 */

import { buildZip, type ZipEntry } from './zip.ts'

const encoder = new TextEncoder()

// ---------------------------------------------------------------------------
// 块级解析
// ---------------------------------------------------------------------------

type Block =
  | { readonly kind: 'h1' | 'h2' | 'h3'; readonly text: string }
  | { readonly kind: 'p'; readonly text: string }
  | { readonly kind: 'bullet'; readonly text: string }
  | { readonly kind: 'table'; readonly rows: readonly (readonly string[])[] }

export function parseMarkdownBlocks(markdown: string): Block[] {
  const blocks: Block[] = []
  const lines = markdown.split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    const trimmed = line.trim()

    if (trimmed === '' || /^-{3,}$/.test(trimmed)) {
      i += 1
      continue
    }

    // 表格：连续的 | 行（跳过分隔行）
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      const rows: string[][] = []
      while (i < lines.length) {
        const candidate = lines[i]!.trim()
        if (!(candidate.startsWith('|') && candidate.endsWith('|'))) break
        const cells = candidate.slice(1, -1).split('|').map(c => c.trim())
        const isSeparator = cells.every(c => /^:?-{2,}:?$/.test(c))
        if (!isSeparator && cells.some(c => c !== '')) rows.push(cells)
        i += 1
      }
      if (rows.length > 0) blocks.push({ kind: 'table', rows })
      continue
    }

    const h = /^(#{1,3})\s+(.*)$/.exec(line)
    if (h !== null) {
      const level = h[1]!.length
      const kind = level === 1 ? 'h1' as const : level === 2 ? 'h2' as const : 'h3' as const
      blocks.push({ kind, text: h[2]!.trim() })
      i += 1
      continue
    }

    if (/^[-*]\s+/.test(trimmed)) {
      blocks.push({ kind: 'bullet', text: trimmed.replace(/^[-*]\s+/, '') })
      i += 1
      continue
    }

    blocks.push({ kind: 'p', text: trimmed.replace(/^>\s?/, '') })
    i += 1
  }
  return blocks
}

// ---------------------------------------------------------------------------
// 行内解析与 XML
// ---------------------------------------------------------------------------

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

interface Run {
  readonly text: string
  readonly bold: boolean
}

function parseInline(text: string): Run[] {
  const runs: Run[] = []
  // 先还原链接为文字
  const noLinks = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  const parts = noLinks.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
  for (const part of parts) {
    if (part === '' || part === undefined) continue
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      runs.push({ text: part.slice(2, -2), bold: true })
    } else if (part.startsWith('`') && part.endsWith('`') && part.length > 1) {
      runs.push({ text: part.slice(1, -1), bold: false })
    } else {
      runs.push({ text: part, bold: false })
    }
  }
  return runs
}

function runsXml(runs: readonly Run[]): string {
  return runs.map(run =>
    `<w:r><w:rPr>${run.bold ? '<w:b/>' : ''}</w:rPr><w:t xml:space="preserve">${escapeXml(run.text)}</w:t></w:r>`,
  ).join('')
}

function paragraphXml(text: string, styleId?: string, pageBreakBefore = false): string {
  const pPr = styleId !== undefined || pageBreakBefore
    ? `<w:pPr>${styleId !== undefined ? `<w:pStyle w:val="${styleId}"/>` : ''}${pageBreakBefore ? '<w:pageBreakBefore/>' : ''}</w:pPr>`
    : ''
  return `<w:p>${pPr}${runsXml(parseInline(text))}</w:p>`
}

function blockXml(block: Block): string {
  switch (block.kind) {
    case 'h1': return paragraphXml(block.text, 'Heading1', true)
    case 'h2': return paragraphXml(block.text, 'Heading2')
    case 'h3': return paragraphXml(block.text, 'Heading3')
    case 'p': return paragraphXml(block.text)
    case 'bullet': return paragraphXml(`• ${block.text}`, 'ListBullet')
    case 'table': {
      const rows = block.rows.map(row => {
        const cells = row.map(cell => `<w:tc><w:p>${runsXml(parseInline(cell))}</w:p></w:tc>`).join('')
        return `<w:tr>${cells}</w:tr>`
      }).join('')
      return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/></w:tblPr>${rows}</w:tbl>`
    }
  }
}

// ---------------------------------------------------------------------------
// 文档装配
// ---------------------------------------------------------------------------

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>
`

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>
`

const DOCUMENT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>
`

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault><w:rPr>
      <w:rFonts w:ascii="Times New Roman" w:eastAsia="宋体" w:hAnsi="Times New Roman"/>
      <w:sz w:val="24"/><w:szCs w:val="24"/>
    </w:rPr></w:rPrDefault>
    <w:pPrDefault><w:pPr><w:spacing w:line="360" w:lineRule="auto"/></w:pPr></w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="TitlePage">
    <w:name w:val="Title Page"/>
    <w:pPr><w:jc w:val="center"/><w:spacing w:before="1200" w:after="240"/></w:pPr>
    <w:rPr><w:rFonts w:eastAsia="黑体"/><w:b/><w:sz w:val="44"/><w:szCs w:val="44"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Subtitle">
    <w:name w:val="Subtitle"/>
    <w:pPr><w:jc w:val="center"/><w:spacing w:after="240"/></w:pPr>
    <w:rPr><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/>
    <w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr>
    <w:rPr><w:rFonts w:eastAsia="黑体"/><w:b/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading2">
    <w:name w:val="heading 2"/>
    <w:pPr><w:spacing w:before="200" w:after="100"/></w:pPr>
    <w:rPr><w:rFonts w:eastAsia="黑体"/><w:b/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading3">
    <w:name w:val="heading 3"/>
    <w:pPr><w:spacing w:before="160" w:after="80"/></w:pPr>
    <w:rPr><w:rFonts w:eastAsia="黑体"/><w:b/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/></w:style>
  <w:style w:type="table" w:styleId="TableGrid">
    <w:name w:val="Table Grid"/>
    <w:tblPr>
      <w:tblBorders>
        <w:top w:val="single" w:sz="4" w:color="000000"/>
        <w:left w:val="single" w:sz="4" w:color="000000"/>
        <w:bottom w:val="single" w:sz="4" w:color="000000"/>
        <w:right w:val="single" w:sz="4" w:color="000000"/>
        <w:insideH w:val="single" w:sz="4" w:color="000000"/>
        <w:insideV w:val="single" w:sz="4" w:color="000000"/>
      </w:tblBorders>
    </w:tblPr>
  </w:style>
</w:styles>
`

export interface DocxOptions {
  readonly title: string
  readonly markdown: string
}

/**
 * 生成完整 .docx 字节。title 渲染为封面页；markdown 为正文（章节合并内容）。
 */
export function buildDocx(opts: DocxOptions): Uint8Array {
  const blocks = parseMarkdownBlocks(opts.markdown)
  const body: string[] = []
  body.push(paragraphXml(opts.title, 'TitlePage'))
  body.push(paragraphXml('本科毕业论文（设计）', 'Subtitle'))
  body.push('<w:p/>')
  for (const block of blocks) body.push(blockXml(block))

  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${body.join('')}
    <w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>
  </w:body>
</w:document>
`

  const entries: ZipEntry[] = [
    { name: '[Content_Types].xml', data: encoder.encode(CONTENT_TYPES) },
    { name: '_rels/.rels', data: encoder.encode(ROOT_RELS) },
    { name: 'word/document.xml', data: encoder.encode(document) },
    { name: 'word/styles.xml', data: encoder.encode(STYLES) },
    { name: 'word/_rels/document.xml.rels', data: encoder.encode(DOCUMENT_RELS) },
  ]
  return buildZip(entries)
}
