/**
 * ZIP 读取器测试：STORE/DEFLATE 两条路径、损坏输入、条目名编码、上限。
 * 夹具全部由代码构造（`tests/ingest-fixtures.ts`），仓库里不放二进制文件。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readZipEntry, openZip, zipEntryNames, ZipError, crc32 } from '../src/ingest/zip.ts'
import { buildTestZip } from './ingest-fixtures.ts'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

test('zip：STORE 条目可读，字节一致', () => {
  const bytes = buildTestZip([{ name: 'a.txt', text: 'hello world' }, { name: 'dir/b.xml', text: '<x/>' }])
  const zip = openZip(bytes)
  assert.deepEqual(zipEntryNames(bytes), ['a.txt', 'dir/b.xml'])
  assert.equal(decoder.decode(zip.read('a.txt')!), 'hello world')
  assert.equal(decoder.decode(readZipEntry(bytes, 'dir/b.xml')!), '<x/>')
})

test('zip：DEFLATE 条目走 inflateRawSync 解压', () => {
  const payload = '压缩内容'.repeat(50)
  const bytes = buildTestZip([{ name: 'c.txt', text: payload, deflate: true }])
  const zip = openZip(bytes)
  const entry = zip.list().find(item => item.name === 'c.txt')
  assert.equal(entry?.method, 8, '应当使用 DEFLATE')
  assert.equal(decoder.decode(zip.read('c.txt')!), payload)
})

test('zip：DEFLATE 条目压缩后确实变小（证明真的压缩了）', () => {
  const payload = 'A'.repeat(500)
  const stored = buildTestZip([{ name: 's.txt', text: payload }])
  const deflated = buildTestZip([{ name: 's.txt', text: payload, deflate: true }])
  assert.ok(deflated.length < stored.length, '压缩后文件应更小')
})

test('zip：缺失条目返回 undefined，require 抛可读错误', () => {
  const bytes = buildTestZip([{ name: 'only.txt', text: 'x' }])
  assert.equal(openZip(bytes).read('nope.txt'), undefined)
  assert.throws(() => openZip(bytes).require('nope.txt'), (error: unknown) => {
    assert.ok(error instanceof ZipError)
    assert.equal(error.code, 'missing-entry')
    assert.match(error.message, /找不到必需条目/)
    return true
  })
})

test('zip：CRC 不匹配必须报错（数据被篡改）', () => {
  const bytes = buildTestZip([{ name: 'a.txt', text: 'hello world' }])
  // 把条目数据里的 'hello' 改成 'hallo'，CRC 就会对不上
  const index = bytes.indexOf(0x68) // 'h'
  bytes[index] = 0x48 // 'H'
  assert.throws(() => openZip(bytes).read('a.txt'), (error: unknown) => {
    assert.ok(error instanceof ZipError)
    assert.equal(error.code, 'crc-mismatch')
    assert.match(error.message, /CRC32 校验失败/)
    return true
  })
})

test('zip：截断的文件报"截断/EOCD 找不到"而不是返回垃圾', () => {
  const bytes = buildTestZip([{ name: 'a.txt', text: 'hello' }])
  assert.throws(() => openZip(bytes.subarray(0, bytes.length - 30)), ZipError)
  assert.throws(() => openZip(new Uint8Array(0)), (error: unknown) => {
    assert.ok(error instanceof ZipError)
    assert.match(error.message, /不是有效的 ZIP|连 ZIP 尾部记录/)
    return true
  })
})

test('zip：中央目录被破坏时报错', () => {
  const bytes = buildTestZip([{ name: 'a.txt', text: 'hello' }])
  // 破坏中央目录项签名（EOCD 前 22+ 字节处）
  const centralOffset = bytes.length - 22 - (46 + 'a.txt'.length)
  bytes[centralOffset] = 0x00
  assert.throws(() => openZip(bytes), (error: unknown) => {
    assert.ok(error instanceof ZipError)
    assert.match(error.message, /中央目录/)
    return true
  })
})

test('zip：ZIP64 标记显式报错（不静默读错）', () => {
  const bytes = buildTestZip([{ name: 'a.txt', text: 'hello' }])
  // 把 EOCD 的条目数写成 0xFFFF（ZIP64 哨兵）
  const eocd = bytes.length - 22
  bytes[eocd + 10] = 0xff
  bytes[eocd + 11] = 0xff
  assert.throws(() => openZip(bytes), (error: unknown) => {
    assert.ok(error instanceof ZipError)
    assert.equal(error.code, 'zip64')
    assert.match(error.message, /ZIP64/)
    return true
  })
})

test('zip：不支持的压缩方法报错', () => {
  const bytes = buildTestZip([{ name: 'a.txt', text: 'hello' }])
  // 中央目录里 method 字段（偏移 +10）改成 12（bzip2）
  const centralOffset = bytes.length - 22 - (46 + 'a.txt'.length)
  bytes[centralOffset + 10] = 12
  bytes[centralOffset + 11] = 0
  assert.throws(() => openZip(bytes), (error: unknown) => {
    assert.ok(error instanceof ZipError)
    assert.equal(error.code, 'unsupported-method')
    return true
  })
})

test('zip：UTF-8 条目名（flag bit 11）正确解码中文', () => {
  const bytes = buildTestZip([{ name: '材料/论文模板.docx', text: 'x' }])
  assert.deepEqual(zipEntryNames(bytes), ['材料/论文模板.docx'])
})

test('zip：非 UTF-8（无 flag）的条目名走 CP437/GBK 回退，不抛错', () => {
  const bytes = buildTestZip([{ name: 'plain.txt', text: 'x' }])
  // 清掉中央目录与本地头的 UTF-8 flag，模拟老工具
  const centralOffset = bytes.length - 22 - (46 + 'plain.txt'.length)
  bytes[centralOffset + 8] = 0
  bytes[centralOffset + 9] = 0
  assert.deepEqual(zipEntryNames(bytes), ['plain.txt'])
})

test('crc32：与已知值一致', () => {
  assert.equal(crc32(encoder.encode('123456789')), 0xcbf43926)
  assert.equal(crc32(encoder.encode('')), 0)
})

test('zip：目录条目被 names() 过滤，list() 仍可见', () => {
  const bytes = buildTestZip([{ name: 'dir/', text: '' }, { name: 'dir/a.txt', text: 'x' }])
  const zip = openZip(bytes)
  assert.deepEqual(zip.names(), ['dir/a.txt'])
  assert.equal(zip.list().length, 2)
})
