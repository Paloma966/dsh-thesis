/**
 * 零依赖 ZIP 写入器（仅 STORE 无压缩），用于产出 .docx。
 *
 * .docx 是 ZIP 容器；Word/WPS 对 STORE（method 0）条目完全兼容。
 * 条目名使用 UTF-8（general purpose flag bit 11），CRC32 自实现。
 */

export interface ZipEntry {
  readonly name: string
  readonly data: Uint8Array
}

// ---------------------------------------------------------------------------
// CRC32（IEEE 802.3，多项式 0xEDB88320，表驱动）
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

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff
  for (const byte of data) {
    c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

// ---------------------------------------------------------------------------
// 组装
// ---------------------------------------------------------------------------

const encoder = new TextEncoder()

function u16le(value: number): Uint8Array {
  const out = new Uint8Array(2)
  out[0] = value & 0xff
  out[1] = (value >>> 8) & 0xff
  return out
}

function u32le(value: number): Uint8Array {
  const out = new Uint8Array(4)
  out[0] = value & 0xff
  out[1] = (value >>> 8) & 0xff
  out[2] = (value >>> 16) & 0xff
  out[3] = (value >>> 24) & 0xff
  return out
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

export function buildZip(entries: readonly ZipEntry[]): Uint8Array {
  const localParts: Uint8Array[] = []
  const centralParts: Uint8Array[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name)
    const crc = crc32(entry.data)
    const size = entry.data.length

    // 本地文件头
    const local = concat([
      u32le(0x04034b50),
      u16le(20), // version needed
      u16le(0x0800), // flags: UTF-8 名称
      u16le(0), // method: STORE
      u16le(0), u16le(0), // 时间/日期（0 合法）
      u32le(crc),
      u32le(size),
      u32le(size),
      u16le(nameBytes.length),
      u16le(0), // extra 长度
      nameBytes,
      entry.data,
    ])
    localParts.push(local)

    // 中央目录项
    const central = concat([
      u32le(0x02014b50),
      u16le(20), u16le(20), // 版本
      u16le(0x0800),
      u16le(0),
      u16le(0), u16le(0),
      u32le(crc),
      u32le(size),
      u32le(size),
      u16le(nameBytes.length),
      u16le(0), u16le(0), u16le(0), // extra/comment/disk/attrs
      u16le(0), // internal attrs
      u32le(0), // external attrs
      u32le(offset),
      nameBytes,
    ])
    centralParts.push(central)
    offset += local.length
  }

  const centralDir = concat(centralParts)
  const centralSize = centralDir.length
  const count = entries.length
  const eocd = concat([
    u32le(0x06054b50),
    u16le(0), u16le(0), // 磁盘号
    u16le(count), u16le(count),
    u32le(centralSize),
    u32le(offset),
    u16le(0), // comment 长度
  ])

  return concat([...localParts, centralDir, eocd])
}

/** 测试辅助：在 zip 字节里搜索给定条目名是否存在（字节级验证）。 */
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
