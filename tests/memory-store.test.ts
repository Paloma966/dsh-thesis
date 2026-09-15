/**
 * SQLite 记忆存储的单元测试（真实 node:sqlite，进程内 `:memory:` 库）。
 *
 * 这里刻意测 {@link MemoryStore} 而不是 `ctx.memory` 服务：存储层零 cordis
 * 依赖，因此记忆语义可以在没有宿主运行时的环境里被完整验证；服务外壳
 * （Service 注册）由 `test-composition` 的装配测试覆盖。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore, normalizeKey } from '../src/memory/store.ts'

test('remember：新建、原地更新保留 createdAt、拒绝空 key', () => {
  const store = new MemoryStore(':memory:')
  try {
    const first = store.remember({ key: 'alpha.project.language', value: 'Go', type: 'fact', source: 'manual', confidence: 1 })
    assert.deepEqual(first, { action: 'created', key: 'alpha.project.language', value: 'Go' })

    const before = store.search('go')[0]!
    assert.equal(before.createdAt > 0, true)

    const update = store.remember({ key: 'alpha.project.language', value: 'TypeScript', type: 'fact', source: 'manual', confidence: 0.9 })
    assert.equal(update.action, 'updated')

    const after = store.search('typescript')[0]!
    assert.equal(after.createdAt, before.createdAt, '更新必须保留创建时间')
    assert.ok(after.updatedAt >= before.updatedAt)

    assert.throws(
      () => store.remember({ key: '   ', value: 'x', type: 'fact', source: 's', confidence: 1 }),
      /non-empty/,
    )
    assert.throws(() => normalizeKey(''), /non-empty/)
    assert.equal(normalizeKey('  a.b  '), 'a.b')
  } finally {
    store.close()
  }
})

test('search：子串匹配、命名空间过滤、limit、按 key 排序', () => {
  const store = new MemoryStore(':memory:')
  try {
    store.remember({ key: 'beta.c', value: 'Rust', type: 'fact', source: 's', confidence: 1 })
    store.remember({ key: 'alpha.a', value: 'Go', type: 'fact', source: 's', confidence: 1 })
    store.remember({ key: 'alpha.b', value: 'Hugo', type: 'fact', source: 's', confidence: 1 })

    assert.deepEqual(store.search('rust').map(e => e.key), ['beta.c'])
    assert.deepEqual(store.search('RUST').map(e => e.key), ['beta.c'], '检索大小写不敏感')
    assert.deepEqual(store.search('', { namespace: 'alpha' }).map(e => e.key), ['alpha.a', 'alpha.b'])
    assert.deepEqual(store.search('go').map(e => e.key), ['alpha.a', 'alpha.b'], '值里的子串也命中（Go/Hugo）')
    assert.deepEqual(store.search('nothing'), [])
    assert.throws(
      () => store.search(''),
      /非空 query，或一个 namespace/,
      '空 query 不得退化成"匹配一切"',
    )
    assert.deepEqual(
      store.search('', { namespace: 'alpha', limit: 0 }).map(e => e.key),
      ['alpha.a'],
      'limit<=0 夹到 1，不得绕开 LIMIT 返回整张表',
    )
    assert.deepEqual(
      store.search('', { namespace: 'alpha', limit: -5 }).map(e => e.key),
      ['alpha.a'],
      '负数 limit 同样夹到 1',
    )
  } finally {
    store.close()
  }
})

test('context：精确 topic 与前缀并列返回', () => {
  const store = new MemoryStore(':memory:')
  try {
    store.remember({ key: 'alpha.project.language', value: 'Go', type: 'fact', source: 's', confidence: 1 })
    store.remember({ key: 'alpha.project.owner', value: '张三', type: 'entity', source: 's', confidence: 1 })
    store.remember({ key: 'alpha', value: 'top', type: 'fact', source: 's', confidence: 1 })
    store.remember({ key: 'alphaX.other', value: '不该命中', type: 'fact', source: 's', confidence: 1 })

    assert.deepEqual(
      store.context('alpha.project').map(e => e.key),
      ['alpha.project.language', 'alpha.project.owner'],
    )
    assert.deepEqual(
      store.context('alpha').map(e => e.key),
      ['alpha', 'alpha.project.language', 'alpha.project.owner'],
      '前缀匹配必须是 alpha. 而不是 alphaX',
    )
    assert.deepEqual(store.context('nothing'), [])
  } finally {
    store.close()
  }
})

test('落盘持久化：文件库关闭后重开仍在，且父目录自动创建', () => {
  const dir = mkdtempSync(join(tmpdir(), 'thesis-memory-'))
  const dbPath = join(dir, 'nested', 'thesis-memory.db')
  try {
    const first = new MemoryStore(dbPath)
    first.remember({ key: 'thesis.demo.school', value: '示例大学', type: 'fact', source: 'intake', confidence: 0.9 })
    first.close()

    const second = new MemoryStore(dbPath)
    const rows = second.context('thesis.demo')
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.value, '示例大学')
    assert.equal(rows[0]!.source, 'intake')
    assert.equal(rows[0]!.confidence, 0.9)
    second.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
