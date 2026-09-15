/**
 * 降重模块的文本归一化与切分（确定性，无第三方依赖）。
 *
 * 两件事：
 * 1. **归一化**：全角/半角统一（NFKC 的常用子集）、去 Markdown 标记与空白标点、
 *    中文按字切分、拉丁按词切分（统一小写）。归一化后每个字符都带一条
 *    「原文偏移」记录，使任何命中都能回到原始行号与原文片段。
 * 2. **段落切分**：按空行与 Markdown 结构切段，标题行/代码块/公式行/
 *    参考文献条目/表格行/引用块不算正文重复；短于 `minChars` 的段落跳过。
 *
 * 归一化与偏移必须一一对应：{@link NormalizedText.chars} 的第 i 个字符来自
 * {@link NormalizedText.tokens} 中某个 token 的第 j 个字符，而该 token 记录了
 * 它在**原文**中的起止偏移（`[start, end)`）。
 *
 * @module dsh-thesis/dedup
 */

/** 单个词元：`text` 是归一化后的小写形式，`[start, end)` 是它在原文中的区间。 */
export interface NormalizedToken {
  readonly text: string
  readonly start: number
  readonly end: number
}

/** 归一化后的单个字符及其原文偏移（token 边界会打断连续区间）。 */
export interface NormalizedChar {
  readonly ch: string
  readonly offset: number
  /** 该字符是否是新 token 的第一个字符（用于按词重建，而不是按字）。 */
  readonly tokenStart: boolean
  readonly breakBefore: boolean
}

export interface NormalizedText {
  readonly text: string
  readonly tokens: readonly NormalizedToken[]
  readonly chars: readonly NormalizedChar[]
}

/** 正文段落：归一化结果 + 它在原文件里的位置与原文。 */
export interface Segment {
  /** 来源文件（相对论文工作区根，POSIX 分隔符）。 */
  readonly file: string
  /** 章名（文件基名去掉 .md）；非章节语料等于 file。 */
  readonly chapter: string
  /** 段落起始行（1 基，闭区间）。 */
  readonly lineStart: number
  /** 段落结束行（1 基，闭区间）。 */
  readonly lineEnd: number
  /**
   * 段落原文（全文行拼接，保留 Markdown 标记与全角标点，用于展示与处方）。
   * 只做换行统一，字符偏移与原文一致。
   */
  readonly raw: string
  /** 归一化输入（全角→半角之后的整篇文本）；所有偏移相对它计算。 */
  readonly text: string
  /** 归一化结果。 */
  readonly doc: NormalizedText
}

export interface SegmentOptions {
  /** 参与比对的最短段落长度（归一化字符数）。 */
  readonly minChars: number
}

// ---------------------------------------------------------------------------
// 全角 / 半角
// ---------------------------------------------------------------------------

/** 常见中文标点 → ASCII 等价物；归一化后会被当作可忽略标点。 */
const PUNCT_MAP: Readonly<Record<string, string>> = {
  '，': ',', '。': '.', '、': ',', '；': ';', '：': ':', '？': '?', '！': '!',
  '（': '(', '）': ')', '【': '[', '】': ']', '《': '<', '》': '>',
  '“': '"', '”': '"', '‘': "'", '’': "'", '—': '-', '–': '-', '…': '.',
  '～': '~', '·': '.', '　': ' ',
}

/**
 * 全角 → 半角、常见中文标点 → ASCII、统一大小写与换行符。
 * 除 BOM（丢弃）与 CRLF（合并为一个 `\n`）外逐字符等长替换，
 * 因此行号与原文字符偏移都保持可对应。
 */
export function toHalfWidth(input: string): string {
  let out = ''
  let pendingCr = false
  for (const ch of input) {
    if (ch === '\uFEFF') continue
    if (ch === '\r') {
      out += '\n'
      pendingCr = true
      continue
    }
    if (ch === '\n') {
      // CRLF 只算一次换行（保证行号与原始文件一致）。
      if (!pendingCr) out += '\n'
      pendingCr = false
      continue
    }
    pendingCr = false
    if (ch === '\t') {
      out += ch
      continue
    }
    const mapped = PUNCT_MAP[ch]
    if (mapped !== undefined) {
      out += mapped
      continue
    }
    const code = ch.codePointAt(0) ?? 0
    if (code >= 0xFF01 && code <= 0xFF5E) {
      out += String.fromCharCode(code - 0xFEE0)
      continue
    }
    out += ch
  }
  return out
}

// ---------------------------------------------------------------------------
// 行级屏蔽（结构行不算正文）
// ---------------------------------------------------------------------------

/** 标题行：`# 标题`。 */
export function isHeadingLine(line: string): boolean {
  return /^\s{0,3}#{1,6}\s/.test(line)
}

/** 围栏代码块：``` 或 ~~~（≥3 个）。 */
export function isCodeFence(line: string): boolean {
  return /^\s{0,3}(`{3,}|~{3,})/.test(line)
}

/** 缩进代码块（4 空格 / 1 个制表符开头）。 */
export function isIndentedCode(line: string): boolean {
  return /^( {4,}|\t)\S/.test(line)
}

/** 独立公式行：`$$...$$`、`\begin{...}` 环境，或整行基本由数学符号构成。 */
export function isFormulaLine(line: string): boolean {
  const t = line.trim()
  if (t === '') return false
  if (/^\$\$/.test(t) || /^\\[a-zA-Z]*\{?(equation|align|array)/.test(t)) return true
  const compact = t.replace(/\s/g, '')
  if (!/[$\\=]/.test(t) || compact.length === 0) return false
  const math = compact.replace(/[^$\\=+\-*/^_{}()[\]]/g, '').length
  return math >= compact.length * 0.5
}

/** 图片行、水平分割线、HTML 注释行。 */
export function isStructuralLine(line: string): boolean {
  const t = line.trim()
  return /^!\[/.test(t) || /^(-{3,}|\*{3,}|_{3,})$/.test(t) || /^<!--/.test(t) || /-->$/.test(t)
}

/** 表格行。 */
export function isTableLine(line: string): boolean {
  return /^\s{0,3}\|/.test(line)
}

/** 引用块行（以 `>` 开头的说明性文字）。 */
export function isQuoteLine(line: string): boolean {
  return /^\s{0,3}>/.test(line)
}

/** 列表项行（提纲/清单，不是连续论述）。 */
export function isListItemLine(line: string): boolean {
  return /^\s{0,3}([-*+]|\d+[.)])\s/.test(line)
}

/** 参考文献标题（`## 参考文献` / `# References` 等）。 */
export function isReferenceHeading(line: string): boolean {
  const t = line.trim().replace(/^#{1,6}\s*/, '')
  return /^(参考文献|引用文献|references?|bibliography)$/i.test(t)
}

/** 参考文献条目行：`[1] 作者. 题名. 期刊, 年.` */
export function isReferenceEntry(line: string): boolean {
  return /^\s{0,3}\[\d{1,3}\]\s*\S/.test(line)
}

/** 模板脚手架提示行（`（写作要求：...）`、`（待补）` 等）。 */
export function isPlaceholderLine(line: string): boolean {
  const t = line.trim()
  return /^[（(]\s*(写作要求|待补|待写|待演练|待填写)/.test(t) || /^(TODO|TBD|FIXME)\b/.test(t)
}

/** 该行是否属于「不构成正文重复」的结构行（不含空行判断）。 */
export function isSkippedLine(line: string): boolean {
  return isHeadingLine(line)
    || isCodeFence(line)
    || isIndentedCode(line)
    || isFormulaLine(line)
    || isStructuralLine(line)
    || isTableLine(line)
    || isQuoteLine(line)
    || isListItemLine(line)
    || isReferenceHeading(line)
    || isReferenceEntry(line)
    || isPlaceholderLine(line)
}

// ---------------------------------------------------------------------------
// 归一化 + 偏移映射
// ---------------------------------------------------------------------------

function isCjk(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0
  return (code >= 0x4E00 && code <= 0x9FFF)
    || (code >= 0x3400 && code <= 0x4DBF)
    || (code >= 0xF900 && code <= 0xFAFF)
}

function isLatinStart(ch: string): boolean {
  return /[A-Za-z\u00C0-\u024F]/.test(ch)
}

function isLatinBody(ch: string): boolean {
  return /[A-Za-z0-9_\u00C0-\u024F]/.test(ch)
}

/** 拉丁词内部保留数字与下划线：`http_server`、`apiv2` 仍是可区分的标识符。 */
function isKeptLatin(ch: string): boolean {
  return /[A-Za-z0-9_\u00C0-\u024F]/.test(ch)
}

/** 数字（含小数）：数字是降重的"硬要素"，必须参与比对（改了数字就是改数据）。 */
function isDigitStart(ch: string): boolean {
  return ch >= '0' && ch <= '9'
}

function isDigitBody(ch: string): boolean {
  return (ch >= '0' && ch <= '9') || ch === '.'
}

/**
 * 归一化一段文本，并记录每个归一化字符的原文偏移。
 *
 * 保留中文、拉丁词（含数字与下划线）与独立数字；标点、空白、Markdown 标记
 * 全部丢弃 —— 字符级过滤不会破坏偏移映射（字符是逐个追加的）。
 */
export function normalizeText(text: string): NormalizedText {
  const half = toHalfWidth(text)
  const tokens: NormalizedToken[] = []
  const chars: NormalizedChar[] = []
  let normalized = ''

  const pushChar = (ch: string, offset: number): void => {
    tokens.push({ text: ch, start: offset, end: offset + 1 })
    chars.push({ ch, offset, tokenStart: true, breakBefore: true })
    normalized += ch
  }

  const pushWord = (from: number, to: number, word: string): void => {
    if (word === '') return
    tokens.push({ text: word, start: from, end: to })
    let first = true
    for (let k = 0; k < to - from; k += 1) {
      const c = word[k]
      if (c === undefined) continue
      chars.push({ ch: c, offset: from + k, tokenStart: first, breakBefore: first })
      first = false
    }
    normalized += word
  }

  let i = 0
  while (i < half.length) {
    const ch = half[i]!
    if (isCjk(ch)) {
      pushChar(ch, i)
      i += 1
      continue
    }
    if (isLatinStart(ch)) {
      let j = i + 1
      while (j < half.length && isLatinBody(half[j]!)) j += 1
      pushWord(i, j, half.slice(i, j).toLowerCase())
      i = j
      continue
    }
    if (isDigitStart(ch)) {
      let j = i + 1
      while (j < half.length && isDigitBody(half[j]!)) j += 1
      pushWord(i, j, half.slice(i, j))
      i = j
      continue
    }
    i += 1
  }
  return { text: normalized, tokens, chars }
}

/**
 * 把归一化字符区间 `[from, to)` 映射回**原文**的字符区间。
 * 返回闭开区间 `{ start, end }`；空区间返回 `null`。
 */
export function offsetsFor(doc: NormalizedText, from: number, to: number): { start: number; end: number } | null {
  const lo = Math.max(0, from)
  const hi = Math.min(doc.chars.length, to)
  if (hi <= lo) return null
  const first = doc.chars[lo]!
  const last = doc.chars[hi - 1]!
  return { start: first.offset, end: last.offset + 1 }
}

/** 原文区间 `[start, end)` 的文本（越界自动截断）。 */
export function sliceRaw(raw: string, start: number, end: number): string {
  const lo = Math.max(0, Math.min(raw.length, start))
  const hi = Math.max(lo, Math.min(raw.length, end))
  return raw.slice(lo, hi)
}

/** 原始文本中某个字符偏移对应的 1 基行号。 */
export function lineAt(raw: string, offset: number): number {
  const clamped = Math.max(0, Math.min(raw.length, offset))
  let line = 1
  for (let i = 0; i < clamped; i += 1) {
    if (raw[i] === '\n') line += 1
  }
  return line
}

// ---------------------------------------------------------------------------
// 段落切分
// ---------------------------------------------------------------------------

/**
 * 按空行与 Markdown 结构切段。
 *
 * 规则（全部确定性）：
 * - 围栏代码块（``` 之间）、标题行、公式行、表格行、引用块、列表项行、
 *   参考文献条目/文献区、模板占位行，一律**不参与**比对；
 * - 连续的非跳过行合并为一个段落，段落边界在空行或跳过行处断开；
 * - 归一化后不足 `minChars` 个字符的段落跳过（返回 `skipped` 便于解释原因）。
 */
export function segmentsFromText(
  text: string,
  options: { file: string; chapter?: string; minChars: number },
): { segments: Segment[]; skippedShort: number } {
  // 归一化输入的形态：全角→半角（逐字符等长，BOM 除外）与 CRLF→LF，
  // 因此行号、段内字符偏移都与原文一致。
  const halfText = toHalfWidth(text)
  const halfLines = halfText.split('\n')
  const segments: Segment[] = []
  const chapter = options.chapter ?? options.file
  let skippedShort = 0
  let inCode = false
  let inReferences = false
  let bufferStart = -1
  let bufferEnd = -1

  const flush = (): void => {
    if (bufferStart < 0) return
    const start = bufferStart
    const end = bufferEnd
    bufferStart = -1
    bufferEnd = -1
    const raw = halfLines.slice(start - 1, end).join('\n')
    const doc = normalizeText(raw)
    if (doc.chars.length < options.minChars) {
      skippedShort += 1
      return
    }
    segments.push({
      file: options.file,
      chapter,
      lineStart: start,
      lineEnd: end,
      raw,
      text: raw,
      doc,
    })
  }

  for (let index = 0; index < halfLines.length; index += 1) {
    const line = halfLines[index]!
    const lineNo = index + 1
    if (isCodeFence(line)) {
      flush()
      inCode = !inCode
      continue
    }
    if (inCode) continue
    if (isReferenceHeading(line)) {
      flush()
      inReferences = true
      continue
    }
    if (inReferences) continue
    if (line.trim() === '' || isSkippedLine(line)) {
      flush()
      continue
    }
    if (bufferStart < 0) bufferStart = lineNo
    bufferEnd = lineNo
  }
  flush()
  return { segments, skippedShort }
}
