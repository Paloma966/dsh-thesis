/**
 * 摄取模块的内部类型：各格式抽取器共用的结果/选项形状。
 *
 * 与门面 `index.ts` 的公开结果类型分开，是为了让 `docx.ts`/`pdf.ts` 等
 * 只依赖一个小接口，不反过来依赖门面（避免循环 import）。
 *
 * @module dsh-thesis/ingest
 */

/** 抽取选项：目前只有字符上限（超限即截断并标记）。 */
export interface ExtractOptions {
  /** 文本上限（字符）；超出部分截断，由调用方在结果里打 `truncated`。 */
  readonly maxChars: number
}

/** 单个文件抽取出的一段文本。 */
export interface ExtractResult {
  /** 是否抽取成功；false 时 text 为空，note 是给人看的原因。 */
  readonly ok: boolean
  /** 抽取到的文本（已按 maxChars 截断；ok=false 时为空串）。 */
  readonly text: string
  /** 是否发生了截断（内容超过 maxChars）。 */
  readonly truncated: boolean
  /** 文档标题（docx 的 dc:title、pptx 的 core.xml 标题等），可能没有。 */
  readonly title?: string
  /** 额外说明：格式特性提示、降级原因、无法抽取的原因。 */
  readonly note?: string
  /** 低置信标记：文本量明显偏少（如扫描版 PDF）。 */
  readonly lowConfidence?: boolean
}

/**
 * 按 maxChars 截断文本，并保证「正文 + 截断提示」不超过 maxChars。
 * 返回截断后的文本与是否发生截断。
 */
export function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 0
  if (text.length <= limit) return { text, truncated: false }
  const marker = '\n\n…（内容过长已截断）'
  const room = Math.max(0, limit - marker.length)
  return { text: `${text.slice(0, room)}${marker}`, truncated: true }
}

/** 组装成功结果（统一做截断）。 */
export function successResult(options: {
  text: string
  maxChars: number
  title?: string | undefined
  note?: string | undefined
  lowConfidence?: boolean | undefined
}): ExtractResult {
  const { text, truncated } = truncateText(options.text, options.maxChars)
  const notes: string[] = []
  if (options.note !== undefined && options.note !== '') notes.push(options.note)
  if (truncated) notes.push(`内容超过 ${options.maxChars} 字符上限，已截断。`)
  return {
    ok: true,
    text,
    truncated,
    ...(options.title !== undefined && options.title !== '' ? { title: options.title } : {}),
    ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
    ...(options.lowConfidence === true ? { lowConfidence: true } : {}),
  }
}

/** 组装失败结果（ok=false，text 恒为空）。 */
export function failureResult(reason: string, options?: { title?: string | undefined }): ExtractResult {
  return {
    ok: false,
    text: '',
    truncated: false,
    ...(options?.title !== undefined && options.title !== '' ? { title: options.title } : {}),
    note: reason,
  }
}
