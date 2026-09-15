/**
 * 零依赖 ZIP **读取器**（与 `paper/lib/zip.ts` 的写入器配对）。
 *
 * .docx/.xlsx/.pptx 都是 ZIP 容器，本文件负责把里面的条目安全地取出来：
 * - 从尾部反向定位 EOCD（`0x06054b50`），再解析中央目录项（`0x02014b50`）；
 * - 只支持 method 0（STORE）与 method 8（DEFLATE，用 `node:zlib` 的
 *   `inflateRawSync`）；其余压缩方式显式报错，绝不猜；
 * - 文件名：general purpose flag bit 11 = UTF-8；否则按 CP437 解码（ZIP 规范
 *   的历史默认），再退到 `TextDecoder('gbk')`——中文 Windows 的压缩工具常
 *   直接用 GBK 写条目名；
 * - **防御损坏输入**：截断、越界、ZIP64、条目数/单条目大小超限一律抛
 *   {@link ZipError}（可读中文原因），不返回半截垃圾；可选 CRC32 校验。
 *
 * 为什么不引 fflate/yauzl：本插件要求零第三方依赖（与写入器一致），
 * OOXML 用到的两个压缩方法用一个 `inflateRawSync` 就够。
 *
 * @module dsh-thesis/ingest
 */

import { inflateRawSync } from 'node:zlib'

// ---------------------------------------------------------------------------
// 常量与上限
// ---------------------------------------------------------------------------

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50
const SIG_ZIP64_EOCD = 0x06064b50
const SIG_ZIP64_LOCATOR = 0x07064b50
const SIG_DATA_DESCRIPTOR = 0x08074b50

/** EOCD 固定 22 字节；注释上限 65535 字节。 */
const EOCD_MIN = 22
const MAX_COMMENT = 0xffff

/** 中央目录条目数上限（OOXML 文档远小于此；防超大数字导致长时间循环）。 */
const MAX_ENTRIES = 4096
/** 单条目解压后上限（32MB；docx 正文 XML 通常只有几百 KB）。 */
const MAX_ENTRY_BYTES = 32 * 1024 * 1024
/** 中央目录总字节上限（防止伪造的目录长度让我们扫完整个文件）。 */
const MAX_CENTRAL_BYTES = 64 * 1024 * 1024

const encoder = new TextEncoder()

// ---------------------------------------------------------------------------
// CRC32（IEEE 802.3，多项式 0xEDB88320，表驱动）——与写入器同表，独立实现
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

/** 计算 CRC32（校验 STORE/DEFLATE 条目完整性）。 */
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < data.length; i += 1) {
    c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

// ---------------------------------------------------------------------------
// 错误类型
// ---------------------------------------------------------------------------

/** ZIP 解析/解压错误：message 是给人看的中文原因，code 便于测试断言。 */
export class ZipError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ZipError'
    this.code = code
  }
}

// ---------------------------------------------------------------------------
// 字节读取（全部做边界检查，越界即抛 ZipError）
// ---------------------------------------------------------------------------

function requireRange(view: DataView, offset: number, length: number, what: string): void {
  if (offset < 0 || length < 0 || offset + length > view.byteLength) {
    throw new ZipError('out-of-range', `ZIP 结构越界：${what} 需要 [${offset}, ${offset + length})，文件只有 ${view.byteLength} 字节（文件被截断或已损坏）。`)
  }
}

function u16(view: DataView, offset: number, what: string): number {
  requireRange(view, offset, 2, what)
  return view.getUint16(offset, true)
}

function u32(view: DataView, offset: number, what: string): number {
  requireRange(view, offset, 4, what)
  return view.getUint32(offset, true)
}

// ---------------------------------------------------------------------------
// 文件名编码：UTF-8 / CP437 / GBK
// ---------------------------------------------------------------------------

/** CP437 码位表（0x80–0xFF）——ZIP 规范里非 UTF-8 条目名的默认编码。 */
const CP437 =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒ' +
  'áíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐' +
  '└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀' +
  'αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0'

/** CP437 解码（逐码位查表；非法字节按 U+FFFD 处理，绝不抛错）。 */
function decodeCp437(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i]!
    out += b < 0x80 ? String.fromCharCode(b) : CP437[b - 0x80] ?? '\ufffd'
  }
  return out
}

/** UTF-8 解码（宽松模式：非法序列变 U+FFFD，不抛错）。 */
function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8').decode(bytes)
  } catch {
    return decodeCp437(bytes)
  }
}

/** GBK 解码尝试结果：false = 环境不支持 GBK（缺 ICU），不必再试。 */
let gbkSupported = true

/**
 * GBK 解码器（懒构造）。Node 的 TextDecoder 需要 ICU 才认识 'gbk'；
 * 构造或解码失败时返回 undefined，由调用方回退 CP437。
 */
function decodeGbk(bytes: Uint8Array): string | undefined {
  if (!gbkSupported) return undefined
  try {
    return new TextDecoder('gbk').decode(bytes)
  } catch {
    gbkSupported = false
    return undefined
  }
}

/**
 * 解出条目名。
 * 顺序：flag bit 11 → UTF-8；否则先按 CP437（规范默认），若解出的名字全是
 * 控制字符/替换符再试 GBK。
 */
function decodeName(raw: Uint8Array, flags: number): string {
  if ((flags & 0x0800) !== 0) return decodeUtf8(raw)
  const cp437 = decodeCp437(raw)
  const hasHighByte = raw.some(b => b >= 0x80)
  if (!hasHighByte) return cp437
  // 高位字节：CP437 会解出「┐├╢」这类框线/生僻字符，GBK 更可能是真名。
  const gbk = decodeGbk(raw)
  if (gbk !== undefined && gbk !== cp437 && !gbk.includes('\ufffd')) return gbk
  return cp437
}

// ---------------------------------------------------------------------------
// 条目
// ---------------------------------------------------------------------------

/** 一个中央目录条目（懒解压：只有 read 时才碰数据）。 */
export interface ZipEntry {
  /** 条目名（ZIP 内路径，统一用 `/`）。 */
  readonly name: string
  /** 压缩方法：0=STORE，8=DEFLATE。 */
  readonly method: number
  /** 压缩后大小（字节）。 */
  readonly compressedSize: number
  /** 解压后大小（字节）。 */
  readonly size: number
  /** 目录条目（名字以 `/` 结尾）。 */
  readonly directory: boolean
}

interface EntryInternal extends ZipEntry {
  readonly localHeaderOffset: number
  readonly crc: number
  readonly flags: number
}

/** ZIP 容器读取器：构造时即解析中央目录，条目数据懒解压并缓存。 */
export class ZipReader {
  private readonly bytes: Uint8Array
  private readonly view: DataView
  private readonly entries: EntryInternal[]
  private readonly byName: Map<string, EntryInternal>
  private readonly cache = new Map<string, Uint8Array>()

  constructor(bytes: Uint8Array) {
    this.bytes = bytes
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    this.entries = this.parseCentralDirectory()
    this.byName = new Map()
    for (const entry of this.entries) {
      // 重名条目（合法但罕见）：先出现的胜出，与常见解压器一致。
      if (!this.byName.has(entry.name)) this.byName.set(entry.name, entry)
    }
  }

  /** 全部条目（含目录条目），按中央目录顺序。 */
  list(): readonly ZipEntry[] {
    return this.entries
  }

  has(name: string): boolean {
    return this.byName.has(name)
  }

  /**
   * 按名字取条目字节；不存在返回 undefined。
   * 解压失败/校验失败抛 {@link ZipError}（不返回半截数据）。
   */
  read(name: string): Uint8Array | undefined {
    const entry = this.byName.get(name)
    if (entry === undefined) return undefined
    return this.readEntry(entry)
  }

  /** 必须存在的条目；缺失抛 ZipError（给出「可能是别的格式」的提示）。 */
  require(name: string): Uint8Array {
    const data = this.read(name)
    if (data === undefined) {
      throw new ZipError('missing-entry', `ZIP 中找不到必需条目 ${name}（该文件可能不是有效的 OOXML 文档，或已损坏）。`)
    }
    return data
  }

  /** 条目名里所有以 `prefix` 开头、以 `suffix` 结尾的名字（升序）。 */
  names(prefix = '', suffix = ''): string[] {
    const out: string[] = []
    for (const entry of this.entries) {
      if (entry.directory) continue
      if (!entry.name.startsWith(prefix)) continue
      if (!entry.name.endsWith(suffix)) continue
      out.push(entry.name)
    }
    return out.sort()
  }

  // ---- 内部：EOCD 与中央目录 ----

  /** 从文件尾反向定位 EOCD 签名（最多回退 64KB+22）。 */
  private findEocd(): number {
    const total = this.view.byteLength
    if (total < EOCD_MIN) {
      throw new ZipError('truncated', `文件只有 ${total} 字节，连 ZIP 尾部记录（22 字节）都不够：不是有效的 ZIP/OOXML 文件。`)
    }
    const lowest = Math.max(0, total - EOCD_MIN - MAX_COMMENT)
    for (let i = total - EOCD_MIN; i >= lowest; i -= 1) {
      if (this.view.getUint32(i, true) !== SIG_EOCD) continue
      // 注释长度必须与剩余字节数吻合，否则是数据里碰巧出现的同名字节。
      const commentLength = this.view.getUint16(i + 20, true)
      if (i + EOCD_MIN + commentLength === total) return i
    }
    throw new ZipError('no-eocd', '找不到 ZIP 尾部记录（EOCD）：文件不是 ZIP/OOXML 格式，或已被截断/损坏。')
  }

  private parseCentralDirectory(): EntryInternal[] {
    const eocd = this.findEocd()

    // ZIP64：本模块不实现，但必须显式报错（否则会静默读出错数据）。
    const locator = eocd - 20
    if (locator >= 0 && this.view.getUint32(locator, true) === SIG_ZIP64_LOCATOR) {
      throw new ZipError('zip64', '这是 ZIP64 格式的压缩包（条目数或大小超过 4GB）：本模块不支持 ZIP64，请先用普通方式重新保存该文档。')
    }
    if (eocd >= 4 && this.view.getUint32(eocd - 4, true) === SIG_ZIP64_EOCD) {
      throw new ZipError('zip64', '这是 ZIP64 格式的压缩包：本模块不支持 ZIP64，请重新保存该文档。')
    }

    const total = this.view.byteLength
    const entryCount = u16(this.view, eocd + 10, 'EOCD 条目数')
    const centralSize = u32(this.view, eocd + 12, 'EOCD 中央目录大小')
    const centralOffset = u32(this.view, eocd + 16, 'EOCD 中央目录偏移')

    if (entryCount === 0xffff || centralOffset === 0xffffffff || centralSize === 0xffffffff) {
      throw new ZipError('zip64', '压缩包使用了 ZIP64 扩展字段：本模块不支持，请重新保存该文档。')
    }
    if (entryCount > MAX_ENTRIES) {
      throw new ZipError('too-many-entries', `压缩包条目数 ${entryCount} 超过上限 ${MAX_ENTRIES}：拒绝解析（可能是恶意构造的文件）。`)
    }
    if (centralSize > MAX_CENTRAL_BYTES) {
      throw new ZipError('central-too-large', `中央目录 ${centralSize} 字节超过上限 ${MAX_CENTRAL_BYTES}：拒绝解析。`)
    }
    if (centralOffset + centralSize > total) {
      throw new ZipError('truncated', `中央目录区间 [${centralOffset}, ${centralOffset + centralSize}) 越出文件末尾 ${total} 字节：文件被截断。`)
    }

    const entries: EntryInternal[] = []
    let offset = centralOffset
    for (let i = 0; i < entryCount; i += 1) {
      const signature = u32(this.view, offset, `第 ${i + 1} 个中央目录项签名`)
      if (signature !== SIG_CENTRAL) {
        throw new ZipError('bad-central-entry', `第 ${i + 1} 个中央目录项签名异常（0x${signature.toString(16)}，应为 0x02014b50）：中央目录已损坏。`)
      }
      const flags = u16(this.view, offset + 8, '条目 flags')
      const method = u16(this.view, offset + 10, '条目压缩方法')
      const crc = u32(this.view, offset + 16, '条目 CRC32')
      const compressedSize = u32(this.view, offset + 20, '条目压缩大小')
      const size = u32(this.view, offset + 24, '条目解压大小')
      const nameLength = u16(this.view, offset + 28, '条目名长度')
      const extraLength = u16(this.view, offset + 30, '条目 extra 长度')
      const commentLength = u16(this.view, offset + 32, '条目注释长度')
      const localHeaderOffset = u32(this.view, offset + 42, '条目本地头偏移')

      requireRange(this.view, offset + 46, nameLength + extraLength + commentLength, `第 ${i + 1} 个中央目录项正文`)
      const nameBytes = this.bytes.subarray(offset + 46, offset + 46 + nameLength)
      const name = decodeName(nameBytes, flags)

      if (size === 0xffffffff || compressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
        throw new ZipError('zip64', `条目 ${name || '(未命名)'} 使用 ZIP64 扩展字段：本模块不支持，请重新保存该文档。`)
      }
      if (size > MAX_ENTRY_BYTES) {
        throw new ZipError('entry-too-large', `条目 ${name} 解压后 ${size} 字节，超过上限 ${MAX_ENTRY_BYTES}：拒绝解压。`)
      }
      if (method !== 0 && method !== 8) {
        throw new ZipError('unsupported-method', `条目 ${name} 使用压缩方法 ${method}（仅支持 0=STORE、8=DEFLATE）：无法读取。`)
      }

      entries.push({
        name,
        method,
        compressedSize,
        size,
        directory: name.endsWith('/'),
        localHeaderOffset,
        crc,
        flags,
      })
      offset += 46 + nameLength + extraLength + commentLength
    }

    // 中央目录的字节数与条目数应当自洽；不一致只影响我们已解析的条目，
    // 不做强制校验（部分压缩工具写的 centralSize 略大于实际，属良性偏差）。
    void centralSize
    return entries
  }

  // ---- 内部：解压单条目 ----

  private readEntry(entry: EntryInternal): Uint8Array {
    const cached = this.cache.get(entry.name)
    if (cached !== undefined) return cached

    const headerOffset = entry.localHeaderOffset
    const signature = u32(this.view, headerOffset, `条目 ${entry.name} 本地头签名`)
    if (signature !== SIG_LOCAL) {
      throw new ZipError('bad-local-header', `条目 ${entry.name} 的本地文件头签名异常（0x${signature.toString(16)}，应为 0x04034b50）：文件已损坏。`)
    }
    const localNameLength = u16(this.view, headerOffset + 26, `条目 ${entry.name} 本地头名长度`)
    const localExtraLength = u16(this.view, headerOffset + 28, `条目 ${entry.name} 本地头 extra 长度`)
    const dataStart = headerOffset + 30 + localNameLength + localExtraLength
    const dataEnd = dataStart + entry.compressedSize
    requireRange(this.view, dataStart, entry.compressedSize, `条目 ${entry.name} 压缩数据`)

    const raw = this.bytes.subarray(dataStart, dataEnd)
    let output: Uint8Array
    if (entry.method === 0) {
      if (raw.length !== entry.size) {
        throw new ZipError('size-mismatch', `条目 ${entry.name} 声明 ${entry.size} 字节但实际存了 ${raw.length} 字节：文件已损坏。`)
      }
      output = raw.slice()
    } else {
      output = this.inflate(entry, raw)
    }

    if (output.length !== entry.size) {
      throw new ZipError('size-mismatch', `条目 ${entry.name} 解压得到 ${output.length} 字节，与目录声明的 ${entry.size} 字节不符：文件已损坏。`)
    }
    // flag bit 3：大小/CRC 写在数据描述符里，中央目录的值仍可信，故照样校验。
    const actual = crc32(output)
    if (actual !== entry.crc) {
      throw new ZipError('crc-mismatch', `条目 ${entry.name} CRC32 校验失败（期望 ${entry.crc.toString(16)}，实际 ${actual.toString(16)}）：文件已损坏。`)
    }

    this.cache.set(entry.name, output)
    return output
  }

  private inflate(entry: EntryInternal, raw: Uint8Array): Uint8Array {
    try {
      // 上限取「声明大小」与硬上限的较小者：声明值可能被伪造，硬上限兜底防 zip bomb；
      // 真正的大小一致性由 readEntry 的解压后长度比对保证。
      return inflateRawSync(raw, { maxOutputLength: Math.min(MAX_ENTRY_BYTES, Math.max(entry.size, 1024)) })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/maxOutputLength|output length|larger than/i.test(message)) {
        throw new ZipError('entry-too-large', `条目 ${entry.name} 解压结果超过声明大小 ${entry.size} 字节：疑似 zip bomb，已拒绝。`)
      }
      throw new ZipError('inflate-failed', `条目 ${entry.name} DEFLATE 解压失败：${message}（文件已损坏）。`)
    }
  }
}

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

/** 打开一个 ZIP 容器（解析失败抛 {@link ZipError}）。 */
export function openZip(bytes: Uint8Array): ZipReader {
  return new ZipReader(bytes)
}

/** 按名字读一个条目；容器损坏抛 {@link ZipError}，条目缺失返回 undefined。 */
export function readZipEntry(bytes: Uint8Array, name: string): Uint8Array | undefined {
  return openZip(bytes).read(name)
}

/** 条目名清单（便捷函数，跳过目录条目）。 */
export function zipEntryNames(bytes: Uint8Array): string[] {
  return openZip(bytes).names()
}

/** 把条目字节按 UTF-8 解码成文本（XML/文本条目用）。 */
export function zipText(bytes: Uint8Array, name: string): string | undefined {
  const data = openZip(bytes).read(name)
  if (data === undefined) return undefined
  return decodeUtf8(data)
}

/** 测试/调试辅助：条目名在字节流里是否存在（不改动输入）。 */
export function zipContainsName(zip: Uint8Array, name: string): boolean {
  const needle = encoder.encode(name)
  outer: for (let i = 0; i + needle.length <= zip.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (zip[i + j] !== needle[j]) continue outer
    }
    return true
  }
  return false
}

/** 内部：给 ooxml 的其余部分复用的 UTF-8/GBK 解码。 */
export function decodeBytes(bytes: Uint8Array): string {
  const utf8 = decodeUtf8(bytes)
  if (!utf8.includes('\ufffd')) return utf8
  const gbk = decodeGbk(bytes)
  if (gbk !== undefined && !gbk.includes('\ufffd')) return gbk
  return utf8
}

// 保留：数据描述符签名在本模块只用于文档说明（我们不依赖它定位数据）。
void SIG_DATA_DESCRIPTOR
