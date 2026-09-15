/**
 * 极简 OOXML 文本抽取器：**不是**通用 XML 解析器，只服务 docx/pptx 的文本层。
 *
 * 覆盖范围（够用即止，不追求完整 XML 语义）：
 * - 提取 `<w:t>` / `<a:t>` 等文本节点，处理 `&amp; &lt; &gt; &quot; &apos;`
 *   与十进制/十六进制数字实体；
 * - 按 `<w:p>` / `<a:p>` 切段落；`<w:br>`/`<w:cr>`/`<a:br>` 变换行；
 *   `<w:tab/>` 变制表符；
 * - 表格：一行渲染成一条 tab 分隔文本（`<w:tc>` 前加制表符、`<w:tr>` 结束收行），
 *   单元格内的多个段落用空格拼接；
 * - 跳过 `<w:instrText>`（域代码，不是正文）、`<w:delText>`（修订删除的旧文本）、
 *   `w:commentRangeStart..End` 区间（批注锚点，批注正文不在 document.xml 里）；
 * - 段内换行折叠为空格、首尾空白去掉，但**制表符保留**（表格列分隔依赖它）。
 *
 * 输出统一是 `string[]`（一段一行），由 docx/pptx 模块拼装。
 *
 * @module dsh-thesis/ingest
 */

// ---------------------------------------------------------------------------
// 实体解码
// ---------------------------------------------------------------------------

/** 命名实体表（OOXML 里实际会出现的就这几个，再加 HTML 的 nbsp）。 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
}

/** 把 XML 实体解码成字符；无法识别/越界的实体原样保留（不猜）。 */
export function decodeXmlEntities(input: string): string {
  if (!input.includes('&')) return input
  return input.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16)
      return validCodePoint(code) ? String.fromCodePoint(code) : match
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10)
      return validCodePoint(code) ? String.fromCodePoint(code) : match
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match
  })
}

/** 合法 Unicode 码位（排除代理区与超出 0x10FFFF 的值）。 */
function validCodePoint(code: number): boolean {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return false
  return !(code >= 0xd800 && code <= 0xdfff)
}

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

/**
 * 折叠段内空白：行内换行折叠为空格、去掉首尾空格，但保留制表符与内部空格。
 * （制表符是表格列分隔符，不能动。）
 */
function collapseParagraph(raw: string): string {
  return raw
    .replace(/[\r\n\u2028\u2029]+/g, ' ')
    .replace(/[ \t]+$/, '')
    .replace(/^ +/, '')
}

/** 命名空间感知的标签集合：短名（`p`）或带前缀全名（`w:p`）写法都接受。 */
function tagMatches(names: readonly string[], full: string, short: string): boolean {
  for (const name of names) {
    if (name === full) return true
    if (name.indexOf(':') === -1 && name === short) return true
  }
  return false
}

function shortName(full: string): string {
  const colon = full.lastIndexOf(':')
  return colon === -1 ? full : full.slice(colon + 1)
}

// ---------------------------------------------------------------------------
// 扫描配置
// ---------------------------------------------------------------------------

/** 扫描配置。 */
export interface OoxmlScanConfig {
  /** 段落边界标签（`w:p`）。 */
  readonly paragraphTags: readonly string[]
  /** 文本节点标签（`w:t`）；只取这些标签内的字符数据。 */
  readonly textTags: readonly string[]
  /** 换行标签（`w:br`/`w:cr`/`a:br`）。 */
  readonly breakTags: readonly string[]
  /** 制表标签（`w:tab`）。 */
  readonly tabTags: readonly string[]
  /** 表格单元格标签（`w:tc`）：开始前输出一个制表符。 */
  readonly cellTags: readonly string[]
  /** 表格行标签（`w:tr`）：结束后收一行。 */
  readonly rowTags: readonly string[]
  /** 整段跳过的标签（域代码/修订删除文本/批注区间起点）。 */
  readonly skipTags: readonly string[]
  /** 只抽取该标签内部（如 `dc:title`）；缺省扫描全文。 */
  readonly wantedTag?: string
}

/** docx 正文抽取配置。 */
export const DOCX_PARTS: OoxmlScanConfig = {
  paragraphTags: ['w:p'],
  textTags: ['w:t'],
  breakTags: ['w:br', 'w:cr'],
  tabTags: ['w:tab'],
  cellTags: ['w:tc'],
  rowTags: ['w:tr'],
  skipTags: ['w:instrText', 'w:delText', 'w:commentRangeStart'],
}

/** pptx 幻灯片抽取配置（`a:p`/`a:t`，`a:br` 换行）。 */
export const PPTX_PARTS: OoxmlScanConfig = {
  paragraphTags: ['a:p'],
  textTags: ['a:t'],
  breakTags: ['a:br'],
  tabTags: [],
  cellTags: ['a:tc'],
  rowTags: ['a:tr'],
  skipTags: [],
}

/**
 * 跳过区间的配对查找：`w:instrText`/`w:delText` 自配对；
 * `w:commentRangeStart`（自闭合）配对到 `w:commentRangeEnd`。
 */
function skipPair(name: string): { start: string; end: string } | undefined {
  if (name === 'w:commentRangeStart') return { start: 'w:commentRangeStart', end: 'w:commentRangeEnd' }
  if (name === 'w:instrText' || name === 'w:delText') return { start: name, end: name }
  return undefined
}

// ---------------------------------------------------------------------------
// 主扫描器
// ---------------------------------------------------------------------------

/**
 * 段落抽取主循环。
 *
 * 状态：
 * 1. `wanted` —— 是否在「只抽指定标签」的区间内（缺省恒真）；
 * 2. `skipName` —— 非空表示正在跳过（域代码区间 / 批注锚点区间）；
 * 3. `inText` —— 当前在文本节点内，此时的字符数据才被收集；
 * 4. `inCell`/`cellText` —— 表格单元格内的段落先攒进 cellText；
 * 5. `rowText` —— 一整行的 tab 分隔文本，行闭合时产出。
 *
 * 文本与结构分离：`segment` 负责"一段文本内部"（tab/换行/多 run 拼接），
 * 表格状态只决定这一段写到 cellText 还是直接产出一行。
 */
function parseOoxml(xml: string, config: OoxmlScanConfig): string[] {
  const paragraphs: string[] = []
  let segment = ''
  let inText = false
  let textChunk = ''

  // 跳过区间
  let skipName: string | undefined
  let skipEnd = ''
  let skipDepth = 0

  // 只抽指定标签
  const wantsTag = config.wantedTag !== undefined
  let wanted = !wantsTag
  const wantedShort = wantsTag ? shortName(config.wantedTag!) : ''
  let wantedDepth = 0

  // 表格
  let inCell = false
  let inRow = false
  let cellText = ''
  let rowText = ''

  const hasRows = config.rowTags.length > 0
  const isRow = (full: string, short: string): boolean => hasRows && tagMatches(config.rowTags, full, short)
  const isCell = (full: string, short: string): boolean => config.cellTags.length > 0 && tagMatches(config.cellTags, full, short)
  const isParagraph = (full: string, short: string): boolean => tagMatches(config.paragraphTags, full, short)
  const isTextNode = (full: string, short: string): boolean => tagMatches(config.textTags, full, short)

  /** 收掉当前文本节点的字符数据，作为一个"片段"并进 segment。 */
  const pushSegment = (): void => {
    const text = collapseParagraph(decodeXmlEntities(textChunk))
    textChunk = ''
    inText = false
    if (text === '') return
    if (segment === '') segment = text
    else if (segment.endsWith('\t') || segment.endsWith('\n')) segment += text
    else segment += ` ${text}`
  }

  /** 段落级收尾：把 segment 并进当前容器（单元格 → 行 → 普通段落）。 */
  const finishSegment = (): void => {
    if (inText) pushSegment()
    const trimmed = segment.replace(/[ \t]+$/, '')
    segment = ''
    if (trimmed.trim() === '') return
    if (inCell) cellText = cellText === '' ? trimmed : `${cellText} ${trimmed}`
    else if (inRow) rowText = rowText === '' ? trimmed : `${rowText} ${trimmed}`
    else paragraphs.push(trimmed)
  }

  /** 单元格收尾：把攒下的文本作为一列拼进行（列前带制表符）。 */
  const finishCell = (): void => {
    finishSegment()
    const text = cellText.trim()
    cellText = ''
    inCell = false
    if (text === '') return
    rowText = rowText === '' ? `\t${text}` : `${rowText}\t${text}`
  }

  /** 行收尾：产出一整行 tab 分隔文本。 */
  const finishRow = (): void => {
    if (inCell) {
      // 结构异常（行没闭合就遇到新行/文档结束）：按已有内容收尾。
      finishCell()
    } else {
      finishSegment()
    }
    const text = rowText.trim()
    rowText = ''
    inRow = false
    if (text !== '') paragraphs.push(text)
  }

  let i = 0
  while (i < xml.length) {
    const lt = xml.indexOf('<', i)
    if (lt === -1) {
      if (inText && skipName === undefined && wanted) textChunk += xml.slice(i)
      break
    }
    if (lt > i && inText && skipName === undefined && wanted) textChunk += xml.slice(i, lt)

    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4)
      i = end === -1 ? xml.length : end + 3
      continue
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9)
      const body = xml.slice(lt + 9, end === -1 ? xml.length : end)
      if (inText && skipName === undefined && wanted) textChunk += body
      i = end === -1 ? xml.length : end + 3
      continue
    }
    if (xml.startsWith('<?', lt) || xml.startsWith('<!', lt)) {
      const end = xml.indexOf('>', lt)
      i = end === -1 ? xml.length : end + 1
      continue
    }

    const gt = xml.indexOf('>', lt)
    if (gt === -1) break // 尾部残标签：忽略，不当作文本
    const body = xml.slice(lt + 1, gt)
    i = gt + 1

    const nameMatch = /^\/?\s*([A-Za-z_][\w.:-]*)/.exec(body)
    if (nameMatch === null) continue
    const isEnd = body.startsWith('/')
    const fullName = nameMatch[1]!
    const short = shortName(fullName)
    const selfClosing = body.endsWith('/')

    // ---- 只抽指定标签内部 ----
    if (wantsTag) {
      if (!isEnd && tagMatches([config.wantedTag!], fullName, wantedShort) && !selfClosing) {
        wanted = true
        wantedDepth += 1
      } else if (isEnd && tagMatches([config.wantedTag!], fullName, wantedShort) && wantedDepth > 0) {
        wantedDepth -= 1
        if (wantedDepth === 0) wanted = false
      }
      if (!wanted) continue
    }

    // ---- 跳过区间（域代码 / 修订删除 / 批注锚点） ----
    if (skipName !== undefined) {
      if (isEnd && tagMatches([skipEnd], fullName, shortName(skipEnd))) {
        if (skipDepth > 1 && shortName(skipEnd) === shortName(skipName)) skipDepth -= 1
        else {
          skipName = undefined
          skipEnd = ''
          skipDepth = 0
        }
      } else if (!isEnd && !selfClosing && tagMatches([skipName], fullName, shortName(skipName))) {
        skipDepth += 1
      }
      continue
    }
    if (!isEnd) {
      // 区间起点既可能是成对标签（<w:instrText>…</w:instrText>），
      // 也可能是自闭合标签（<w:commentRangeStart/>），两种都要进入跳过态。
      const hit = config.skipTags.find(tag => tagMatches([tag], fullName, short))
      if (hit !== undefined) {
        const pair = skipPair(hit)
        if (pair !== undefined) {
          skipName = pair.start
          skipEnd = pair.end
          skipDepth = 1
        }
        continue
      }
    }

    // ---- 文本节点 ----
    if (isTextNode(fullName, short)) {
      if (isEnd) {
        if (inText) pushSegment()
      } else if (selfClosing) {
        // `<w:t/>`：空文本，什么也不做。
      } else {
        if (inText) pushSegment() // 非法嵌套：先把上一段收掉
        inText = true
      }
      continue
    }

    // ---- 结构控制 ----
    if (!isEnd && tagMatches(config.breakTags, fullName, short)) {
      segment += '\n'
      continue
    }
    if (!isEnd && tagMatches(config.tabTags, fullName, short)) {
      if (inText) pushSegment()
      segment += '\t'
      continue
    }
    if (!isEnd && isCell(fullName, short)) {
      if (!inCell) {
        finishSegment()
        inCell = true
        cellText = ''
      }
      continue
    }
    if (isEnd && isCell(fullName, short)) {
      if (inCell) finishCell()
      continue
    }
    if (!isEnd && isRow(fullName, short)) {
      if (inRow) finishRow()
      inRow = true
      rowText = ''
      continue
    }
    if (isEnd && isRow(fullName, short)) {
      if (inRow) finishRow()
      continue
    }
    if (isParagraph(fullName, short)) {
      // 段落结束收尾；段落开始时不清 segment（同一单元格内多 run/多段会拼接）。
      if (isEnd) finishSegment()
      continue
    }
  }

  if (inRow) finishRow()
  finishSegment()
  return paragraphs
}

// ---------------------------------------------------------------------------
// 对外入口
// ---------------------------------------------------------------------------

/** 对外主入口：按配置抽取段落。 */
export function extractOoxmlParagraphs(xml: string, config: OoxmlScanConfig): string[] {
  return parseOoxml(xml, config)
}

/** docx 正文 → 段落数组。 */
export function extractDocxParagraphs(documentXml: string): string[] {
  return parseOoxml(documentXml, DOCX_PARTS)
}

/** pptx 幻灯片 → 段落数组。 */
export function extractPptxParagraphs(slideXml: string): string[] {
  return parseOoxml(slideXml, PPTX_PARTS)
}

/** 判断段落数组里是否有可见文本（用于"扫不出字"的判断）。 */
export function hasVisibleText(paragraphs: readonly string[]): boolean {
  return paragraphs.some(paragraph => paragraph.trim() !== '')
}

/**
 * 抽取某个标签内部的所有文本（用于 `dc:title` 这类零散场景）。
 * 内部同样按 `<w:t>`/`<a:t>` 文本节点抽取，不含段落结构。
 */
export function extractElementText(xml: string, wantedTag: string, textTags: readonly string[] = ['t']): string {
  const paragraphs = parseOoxml(xml, {
    paragraphTags: [],
    textTags,
    breakTags: [],
    tabTags: [],
    cellTags: [],
    rowTags: [],
    skipTags: [],
    wantedTag,
  })
  return paragraphs.join(' ').trim()
}

/** 抽取特定标签的文本内容，如 `dc:title`；找不到返回 undefined。 */
export function extractRawElement(xml: string, wantedNames: readonly string[]): string | undefined {
  const found = extractElementText(xml, wantedNames[0] ?? 'title', wantedNames)
  return found === '' ? undefined : found
}
