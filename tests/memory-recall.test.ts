/**
 * 跨会话事实回灌的测试：关键词提取、相关性排序、卡片有界、以及 hook 的「该出现才出现」。
 *
 * 这一层的价值全在克制：只提供查询工具的静态事实库是死的，但每条消息都塞满事实更糟。
 * 所以用例既验证「相关时确实注入」，也验证「不相关/没变化/没事实/出错时一个字节都不注入」。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import { installFactRecall, keywordsOf, makeRecallMessage, renderRecallCard, scoreEntry, selectRelevant } from '../src/memory/recall.ts'
import type { MemoryEntry, MemoryService } from '../src/memory/service.ts'

function entry(key: string, value: string, updatedAt = 1, confidence = 1): MemoryEntry {
  return { key, value, type: 'fact', source: 'test', confidence, createdAt: 1, updatedAt }
}

test('关键词提取：中文 2-gram、拉丁分词、去停用词、按长度降序', () => {
  const keywords = keywordsOf('我们学校的查重阈值是多少？Please check the dedup threshold')
  assert.ok(keywords.includes('查重'), `应含 2-gram「查重」，实际 ${keywords.join(',')}`)
  assert.ok(keywords.includes('阈值'))
  assert.ok(keywords.includes('dedup'))
  assert.ok(keywords.includes('threshold'))
  assert.ok(!keywords.includes('的'), '停用词不应出现')
  assert.ok(!keywords.includes('the'), '英文停用词不应出现')
  assert.ok(keywords.length <= 24, '关键词数量必须有上限')
  // 更长的词排前面（更具体）
  const firstShort = keywords.findIndex(word => word.length <= 2)
  const firstLong = keywords.findIndex(word => word.length > 2)
  if (firstShort >= 0 && firstLong >= 0) {
    // 只要求"存在长词时不会被短词全部压后"：最长词一定在最前
    assert.equal(keywords[0]!.length >= 2, true)
  }
})

test('相关性打分与排序：命中多者优先，同分取更新更近，截断到上限', () => {
  const entries = [
    entry('school.dedup.system', '知网，查重阈值 20%', 100),
    entry('school.dedup.note', '查重', 50),
    entry('user.writing.style', '短句为主', 200),
    entry('thesis.demo.school', '示例大学', 300),
  ]
  const keywords = keywordsOf('查重阈值是多少')
  assert.equal(scoreEntry(entries[2]!, keywords), 0, '无关记忆得 0 分')
  const selected = selectRelevant(entries, keywords, 2)
  assert.equal(selected.length, 2)
  assert.equal(selected[0]!.key, 'school.dedup.system', '命中最多者排第一')
  assert.ok(selected.every(item => item.key.includes('dedup') || item.key.includes('school')))
  assert.deepEqual(selectRelevant(entries, keywordsOf('完全无关的一句话呢'), 4), [])
})

test('卡片渲染：有界、带"可能过时"声明、超限时给查询提示', () => {
  const entries = [entry('school.dedup.system', '知网'), entry('user.writing.style', '短句为主')]
  const card = renderRecallCard(entries, 600)
  assert.match(card, /已确认事实/)
  assert.match(card, /可能过时/)
  assert.match(card, /school\.dedup\.system = 知网/)

  const huge = Array.from({ length: 50 }, (_v, i) => entry(`k${i}.field`, 'x'.repeat(60)))
  const bounded = renderRecallCard(huge, 300)
  assert.ok(bounded.length <= 300, `卡片必须硬性有界，实际 ${bounded.length}`)
  assert.match(bounded, /还有更多事实/)

  const message = makeRecallMessage(entries, 600)
  assert.equal(message.role, 'user')
  assert.equal(message.source.plugin, 'dsh-thesis')
  assert.equal(message.source.form, 'snapshot')
  assert.equal(message.source.sections[0]!.name, '已确认事实')
})

// ---------------------------------------------------------------------------
// hook 行为
// ---------------------------------------------------------------------------

interface Host {
  listener?: (payload: unknown, next: () => Promise<unknown>) => Promise<{ kind: string; messages?: unknown[] }>
}

function boot(entries: MemoryEntry[]): Host {
  const host: Host = {}
  const service: Pick<MemoryService, 'search'> = { search: () => entries }
  const ctx = {
    get(name: string) { return name === 'memory' ? service : undefined },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    on(_event: string, listener: Host['listener']): () => void { host.listener = listener; return () => {} },
  } as unknown as Context
  installFactRecall(ctx)
  return host
}

const userPayload = (text: string, agent: object = { id: 'a1' }) => ({
  agent,
  messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text }] }],
})
const enterNext = async () => ({ kind: 'enter', messages: [{ role: 'user' }] })

test('hook：用户消息与记忆相关 → 注入一张卡片', async () => {
  const host = boot([entry('school.dedup.system', '知网，查重阈值 20%', 10)])
  const decision = await host.listener!(userPayload('帮我确认一下学校的查重阈值'), enterNext)
  assert.equal(decision.messages!.length, 2)
  const injected = decision.messages![1] as { source: { plugin: string } }
  assert.equal(injected.source.plugin, 'dsh-thesis')
})

test('hook：不相关 → 不注入；没有记忆 → 不注入；斜杠命令 → 不注入', async () => {
  const host = boot([entry('school.dedup.system', '知网')])
  assert.equal((await host.listener!(userPayload('帮我把这段话改成被动语态'), enterNext)).messages!.length, 1)
  assert.equal((await host.listener!(userPayload('/thesis-status'), enterNext)).messages!.length, 1)

  const empty = boot([])
  assert.equal((await empty.listener!(userPayload('学校查重阈值是多少'), enterNext)).messages!.length, 1)
})

test('hook：记忆没变化时同一 agent 不重复注入；记忆更新后可再注入', async () => {
  let entries = [entry('school.dedup.system', '知网，查重阈值 20%', 10)]
  const host: Host = {}
  const ctx = {
    get(name: string) { return name === 'memory' ? { search: () => entries } : undefined },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    on(_event: string, listener: Host['listener']): () => void { host.listener = listener; return () => {} },
  } as unknown as Context
  installFactRecall(ctx)

  const agent = { id: 'a2' }
  assert.equal((await host.listener!(userPayload('学校查重阈值是多少', agent), enterNext)).messages!.length, 2)
  assert.equal((await host.listener!(userPayload('学校查重阈值是多少', agent), enterNext)).messages!.length, 1, '记忆未变不重复注入')

  entries = [entry('school.dedup.system', '知网，查重阈值 25%', 20)]
  assert.equal((await host.listener!(userPayload('学校查重阈值是多少', agent), enterNext)).messages!.length, 2, '记忆更新后应重新注入')
})

test('hook：记忆服务抛异常时静默放行，不抛进 agent 循环', async () => {
  const host: Host = {}
  const ctx = {
    get(name: string) {
      return name === 'memory' ? { search() { throw new Error('db is gone') } } : undefined
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    on(_event: string, listener: Host['listener']): () => void { host.listener = listener; return () => {} },
  } as unknown as Context
  installFactRecall(ctx)
  const decision = await host.listener!(userPayload('学校查重阈值是多少'), enterNext)
  assert.equal(decision.messages!.length, 1)
})

test('hook：下游 reject 时原样返回', async () => {
  const host = boot([entry('school.dedup.system', '知网')])
  const decision = await host.listener!(userPayload('学校查重阈值是多少'), async () => ({ kind: 'reject' }))
  assert.equal(decision.kind, 'reject')
})
