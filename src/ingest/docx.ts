/**
 * `.docx` 摄取：ZIP → `word/document.xml` → 段落文本。
 *
 * 说明：
 * - 只读正文（`word/document.xml`），页眉/页脚/脚注/文本框暂不抽取
 *   （文本框内容在 `w:txbxContent` 里，与正文同文档，会被一起抽到）；
 * - 表格保留为制表符分隔的行（见 `ooxml.ts`）；
 * - 标题取 `docProps/core.xml` 的 `dc:title`（Word 的"标题"属性），没有就留空，
 *   不拿正文第一行冒充标题；
 * - 若该文件其实是 xlsx/pptx（改扩展名的常见误操作），给出明确提示而不是报解析错误。
 *
 * @module dsh-thesis/ingest
 */

import { extractElementText, extractDocxParagraphs, extractRawElement } from './ooxml.ts'
import { failureResult, successResult, type ExtractOptions, type ExtractResult } from './types.ts'
import { ZipError, decodeBytes, openZip } from './zip.ts'

/** docx 正文抽取的完整结果（供测试与上层复用）。 */
export interface DocxContent {
  /** `dc:title`（没有则为 undefined）。 */
  readonly title?: string
  /** 段落数组（表格行为 tab 分隔的单段）。 */
  readonly paragraphs: readonly string[]
  /** 段落用换行拼起来的正文。 */
  readonly text: string
}

/** 判定 OOXML 容器的真实类型（按内部条目，而不是扩展名）。 */
export function sniffOoxmlKind(bytes: Uint8Array): 'docx' | 'xlsx' | 'pptx' | undefined {
  try {
    const zip = openZip(bytes)
    if (zip.has('word/document.xml')) return 'docx'
    if (zip.has('xl/workbook.xml')) return 'xlsx'
    if (zip.has('ppt/presentation.xml')) return 'pptx'
    return undefined
  } catch {
    return undefined
  }
}

/** 读取 `docProps/core.xml` 的 `dc:title`。 */
function readCoreTitle(bytes: Uint8Array): string | undefined {
  let core: string
  try {
    core = decodeBytes(openZip(bytes).require('docProps/core.xml'))
  } catch {
    return undefined
  }
  const raw = extractRawElement(core, ['dc:title', 'title'])
  if (raw === undefined) return undefined
  const cleaned = extractElementText(`<x>${raw}</x>`, 'x', ['x']).trim()
  return cleaned === '' ? undefined : cleaned
}

/** 纯抽取：ZIP 字节 → 标题 + 段落（不截断、不做结果包装）。 */
export function readDocx(bytes: Uint8Array): DocxContent {
  const zip = openZip(bytes)
  const documentBytes = zip.read('word/document.xml')
  if (documentBytes === undefined) {
    const actual = sniffOoxmlKind(bytes)
    if (actual === 'xlsx') {
      throw new ZipError('wrong-format', '这个文件内部是 Excel 工作簿（.xlsx），不是 Word 文档：请把扩展名改回 .xlsx，或先另存为 .docx。')
    }
    if (actual === 'pptx') {
      throw new ZipError('wrong-format', '这个文件内部是 PowerPoint 演示文稿（.pptx），不是 Word 文档：请把扩展名改回 .pptx。')
    }
    throw new ZipError('missing-document', '这个 ZIP 里没有 word/document.xml：不是有效的 .docx（可能是 .odt/.zip 或已损坏）。请用 Word/WPS 另存为 .docx。')
  }
  const xml = decodeBytes(documentBytes)
  const paragraphs = extractDocxParagraphs(xml)
  const title = readCoreTitle(bytes)
  return {
    ...(title !== undefined ? { title } : {}),
    paragraphs,
    text: paragraphs.join('\n'),
  }
}

/** 门面用入口：docx 字节 → 抽取结果（含截断/失败原因）。 */
export function extractDocx(bytes: Uint8Array, options: ExtractOptions): ExtractResult {
  let content: DocxContent
  try {
    content = readDocx(bytes)
  } catch (error) {
    const reason = error instanceof ZipError
      ? error.message
      : `读取 .docx 失败：${error instanceof Error ? error.message : String(error)}`
    return failureResult(reason)
  }
  if (content.text.trim() === '') {
    return failureResult('这个 .docx 没有任何正文文本（可能是空文档，或正文全在文本框/图片里）：请另存为含文本的文档再试。')
  }
  return successResult({
    text: content.text,
    maxChars: options.maxChars,
    title: content.title,
    note: `共 ${content.paragraphs.length} 段。`,
  })
}
