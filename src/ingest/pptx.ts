/**
 * `.pptx` 摄取：按 `ppt/slides/slideN.xml` 的**数字顺序**逐页抽文本。
 *
 * 顺序问题：ZIP 中央目录里的条目顺序不等于放映顺序，而且 `ppt/_rels/presentation.xml.rels`
 * 只给出 rId→文件，真正的顺序在 `ppt/presentation.xml` 的 `<p:sldIdLst>` 里。
 * 这里以"文件名里的数字"为准（PowerPoint 自身就是按数字命名并保持顺序的），
 * 数字相同再按字典序，保证确定性。
 *
 * 每页渲染为：
 * ```
 * ## 第 3 页
 * 标题文本
 * 正文第一行
 * 正文第二行
 * ```
 * 标题与正文之间只是换行（`a:p` 之间本就换行），不做"标题/正文"语义猜测。
 *
 * @module dsh-thesis/ingest
 */

import { extractPptxParagraphs, extractRawElement } from './ooxml.ts'
import { failureResult, successResult, type ExtractOptions, type ExtractResult } from './types.ts'
import { ZipError, decodeBytes, openZip } from './zip.ts'

/** 单页最多字符数（防一张疯狂的幻灯片吃掉整个预算）。 */
const SLIDE_CHAR_LIMIT = 50_000
/** 最多渲染的页数。 */
const SLIDE_LIMIT = 500

/** 从 `ppt/slides/slide12.xml` 里取页码 12；取不到返回 Number.MAX_SAFE_INTEGER。 */
export function slideNumber(path: string): number {
  const match = /slide(\d+)\.xml$/i.exec(path)
  if (match === null) return Number.MAX_SAFE_INTEGER
  const value = Number.parseInt(match[1]!, 10)
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER
}

/** 按页码排序幻灯片路径（同页码按字典序）。 */
export function sortSlides(paths: readonly string[]): string[] {
  return [...paths].sort((a, b) => {
    const na = slideNumber(a)
    const nb = slideNumber(b)
    if (na !== nb) return na - nb
    return a.localeCompare(b)
  })
}

/** 读取 `docProps/core.xml` 的 `dc:title`（演示文稿"标题"属性）。 */
function readCoreTitle(bytes: Uint8Array): string | undefined {
  try {
    const core = decodeBytes(openZip(bytes).require('docProps/core.xml'))
    const raw = extractRawElement(core, ['dc:title', 'title'])
    return raw === undefined || raw.trim() === '' ? undefined : raw
  } catch {
    return undefined
  }
}

/** 纯抽取：逐页渲染。 */
export function readPptx(bytes: Uint8Array): { text: string; slides: number; skipped: number } {
  const zip = openZip(bytes)
  if (!zip.has('ppt/presentation.xml') && zip.names('ppt/slides/', '.xml').length === 0) {
    throw new ZipError('missing-presentation', '这个 ZIP 里既没有 ppt/presentation.xml 也没有 ppt/slides/：不是有效的 .pptx（可能是 .ppt 改了扩展名）。请用 PowerPoint/WPS 另存为 .pptx。')
  }
  const slidePaths = sortSlides(zip.names('ppt/slides/', '.xml'))
  if (slidePaths.length === 0) {
    throw new ZipError('no-slides', '演示文稿里没有任何幻灯片：无法抽取内容。')
  }

  const blocks: string[] = []
  let rendered = 0
  let skipped = 0
  for (const path of slidePaths.slice(0, SLIDE_LIMIT)) {
    const paragraphs = extractPptxParagraphs(decodeBytes(zip.require(path)))
    const body = paragraphs.join('\n')
    const page = slideNumber(path)
    const label = page === Number.MAX_SAFE_INTEGER ? path.replace(/^ppt\/slides\//, '').replace(/\.xml$/, '') : String(page)
    if (body.trim() === '') {
      skipped += 1
      blocks.push(`## 第 ${label} 页\n（本页没有文本，可能只有图片）`)
      continue
    }
    const limited = body.length > SLIDE_CHAR_LIMIT ? `${body.slice(0, SLIDE_CHAR_LIMIT)}\n…（本页内容过长已截断）` : body
    blocks.push(`## 第 ${label} 页\n${limited}`)
    rendered += 1
  }

  const notes: string[] = []
  if (slidePaths.length > SLIDE_LIMIT) notes.push(`共 ${slidePaths.length} 页，只渲染了前 ${SLIDE_LIMIT} 页。`)
  if (skipped > 0) notes.push(`其中 ${skipped} 页没有文本（图片页）。`)
  return {
    text: `${blocks.join('\n\n')}${notes.length > 0 ? `\n\n（${notes.join(' ')}）` : ''}\n`,
    slides: slidePaths.length,
    skipped,
  }
}

/** 门面用入口：pptx 字节 → 抽取结果。 */
export function extractPptx(bytes: Uint8Array, options: ExtractOptions): ExtractResult {
  let read: { text: string; slides: number; skipped: number }
  try {
    read = readPptx(bytes)
  } catch (error) {
    const reason = error instanceof ZipError
      ? error.message
      : `读取 .pptx 失败：${error instanceof Error ? error.message : String(error)}`
    return failureResult(reason)
  }
  if (read.text.trim() === '') {
    return failureResult('这个 .pptx 的所有页面都没有文本（可能全图）：没有可摄取的文字。')
  }
  return successResult({
    text: read.text,
    maxChars: options.maxChars,
    title: readCoreTitle(bytes),
    note: `共 ${read.slides} 页。备注页（讲稿）不在其中：如需讲稿请另行提供。`,
    lowConfidence: read.skipped > read.slides / 2,
  })
}
