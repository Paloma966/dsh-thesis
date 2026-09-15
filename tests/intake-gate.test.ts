/**
 * 意图规格闸门的测试：判定规则（纯函数）+ 真实 hook 行为（假宿主 + 假 fs）。
 *
 * 闸门的价值全在「该拦的时候拦住、不该拦的时候安静」，所以两类用例都要有：
 * 命中写作意图且规格缺失 → 注入追问指令；用户说「直接写」/规格已就绪/不在论文
 * 工作区 → 一个字节都不注入。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import { installIntakeGate } from '../src/intake/gate.ts'
import { intakeGateInstruction, isBypassed, isWritingIntent, judgeSpec } from '../src/intake/gate-rules.ts'
import { FakeFs } from './paper-fixtures.ts'

const SPEC_REL = '00-管理/意图规格.md'

test('写作意图识别：命中写论文/章节，不误伤聊天与改格式', () => {
  for (const text of [
    '帮我写第三章',
    '开始写论文正文',
    '接着写文献综述',
    '生成开题报告',
    '继续写 05-系统实现.md',
    'please draft chapter 4',
  ]) {
    assert.equal(isWritingIntent(text), true, `应命中：${text}`)
  }
  for (const text of [
    '你好，这个插件怎么用',
    '把参考文献格式改成 GB/T 7714',
    '论文进度到哪了',
    '帮我把这段话改短一点',
  ]) {
    assert.equal(isWritingIntent(text), false, `不应命中：${text}`)
  }
})

test('显式授权可绕过闸门', () => {
  assert.equal(isBypassed('不用问，直接写第三章'), true)
  assert.equal(isBypassed('帮我写第三章，验收标准：能编译'), false)
})

test('规格状态判定：缺失 / 有未勾选项 / 有未知标记 / 就绪', () => {
  assert.deepEqual(judgeSpec(undefined), { kind: 'missing' })
  assert.deepEqual(judgeSpec('   '), { kind: 'missing' })
  assert.equal(judgeSpec('# 意图规格\n\n- [ ] 学校模板\n- [x] 字数').kind, 'blocked')
  assert.equal(judgeSpec('# 意图规格\n\n查重阈值：未知（需补）').kind, 'blocked')
  assert.deepEqual(judgeSpec('# 意图规格\n\n学校：示例大学\n字数：15000\n- [x] 模板已拿到'), { kind: 'ready' })
})

test('规格状态判定：以「阻塞项」小节为结构判据（与 intake/spec.ts 的渲染契约绑定）', () => {
  const blocked = [
    '# 意图规格',
    '',
    '## 阻塞项（未答不可进入下一阶段）',
    '',
    '| 问题 id | 分节 | 缺什么 | 影响产出 |',
    '|---|---|---|---|',
    '| `school.name` | 学校与规范 | 尚未回答 | 格式检查 |',
  ].join('\n')
  const status = judgeSpec(blocked)
  assert.equal(status.kind, 'blocked')
  assert.match(status.kind === 'blocked' ? status.reason : '', /阻塞项/)

  const ready = [
    '# 意图规格',
    '',
    '## 阻塞项（未答不可进入下一阶段）',
    '',
    '无。全部必答项已齐全。',
    '',
    '## 学校与规范',
    '',
    '| 问题 | 答案 | 来源 |',
    '|---|---|---|',
    '| 学校 | 示例大学 | 用户回答 |',
  ].join('\n')
  assert.equal(judgeSpec(ready).kind, 'ready')
})

test('注入指令：一次只问一个、要求先立规格、声明自身是插件消息', () => {
  const text = intakeGateInstruction({ kind: 'missing' }, SPEC_REL)
  assert.match(text, /一次只问一个/)
  assert.match(text, /thesis_intake/)
  assert.match(text, /意图规格闸门/)
  assert.match(text, /不是用户需求的一部分/)
  const blocked = intakeGateInstruction({ kind: 'blocked', reason: '规格里仍有 2 个未勾选项' }, SPEC_REL)
  assert.match(blocked, /2 个未勾选项/)
})

// ---------------------------------------------------------------------------
// hook 行为
// ---------------------------------------------------------------------------

interface Host {
  readonly ctx: Context
  readonly fs: FakeFs
  listener: ((payload: unknown, next: () => Promise<unknown>) => Promise<{ kind: string; messages?: unknown[] }>) | undefined
}

async function bootHost(options: { spec?: string; ledger?: boolean } = {}): Promise<Host> {
  const fs = new FakeFs()
  const root = 'C:/paper-ws'
  if (options.ledger !== false) await fs.writeText({ displayPath: `${root}/00-管理/进度台账.md` }, '# 台账')
  if (options.spec !== undefined) await fs.writeText({ displayPath: `${root}/${SPEC_REL}` }, options.spec)

  const host: Host = { ctx: undefined as unknown as Context, fs, listener: undefined }
  const ctx = {
    fs,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    on(_event: string, listener: Host['listener']): () => void {
      host.listener = listener
      return () => {}
    },
  } as unknown as Context
  host.ctx = ctx
  installIntakeGate(ctx, { specRel: SPEC_REL })
  return host
}

function userPayload(cwd: string, text: string) {
  return {
    agent: { session: { header: { cwd } } },
    messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text }] }],
    signal: undefined,
  }
}

const enterNext = async () => ({ kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: '原始消息' }] }] })

test('闸门：写作意图 + 规格缺失 → 注入一条插件消息', async () => {
  const host = await bootHost()
  const decision = await host.listener!(userPayload('C:/paper-ws/06-论文', '帮我写第三章'), enterNext)
  assert.equal(decision.kind, 'enter')
  assert.equal(decision.messages!.length, 2, '原始消息 + 注入消息')
  const injected = decision.messages![1] as { source: { plugin: string }; content: Array<{ text: string }> }
  assert.equal(injected.source.plugin, 'dsh-thesis')
  assert.match(injected.content[0]!.text, /意图规格闸门/)
})

test('闸门：规格就绪 → 静默放行', async () => {
  const host = await bootHost({ spec: '# 意图规格\n\n学校：示例大学\n- [x] 模板已拿到' })
  const decision = await host.listener!(userPayload('C:/paper-ws', '帮我写第三章'), enterNext)
  assert.equal(decision.messages!.length, 1)
})

test('闸门：规格仍有阻塞项 → 注入并说明原因', async () => {
  const host = await bootHost({ spec: '# 意图规格\n\n- [ ] 查重阈值\n- [ ] 时间线' })
  const decision = await host.listener!(userPayload('C:/paper-ws', '开始写论文正文'), enterNext)
  assert.equal(decision.messages!.length, 2)
  const injected = decision.messages![1] as { content: Array<{ text: string }> }
  assert.match(injected.content[0]!.text, /未勾选项/)
})

test('闸门：用户显式授权 / 非写作意图 / 不在论文工作区 都不注入', async () => {
  const host = await bootHost()
  assert.equal((await host.listener!(userPayload('C:/paper-ws', '不用问，直接写第三章'), enterNext)).messages!.length, 1)
  assert.equal((await host.listener!(userPayload('C:/paper-ws', '这台机器怎么装数据库'), enterNext)).messages!.length, 1)

  const outside = await bootHost({ ledger: false })
  assert.equal((await outside.listener!(userPayload('C:/somewhere', '帮我写第三章'), enterNext)).messages!.length, 1)
})

test('闸门：下游 reject 时原样返回，不注入', async () => {
  const host = await bootHost()
  const decision = await host.listener!(userPayload('C:/paper-ws', '帮我写第三章'), async () => ({ kind: 'reject' }))
  assert.equal(decision.kind, 'reject')
})

test('闸门：读盘异常不抛进 agent 循环', async () => {
  const host = await bootHost()
  const brokenFs = {
    async resolve() { throw new Error('boom') },
    async readText() { throw new Error('boom') },
    async writeText() { throw new Error('boom') },
    async listDir() { throw new Error('boom') },
    async stat() { throw new Error('boom') },
  }
  const ctx = {
    fs: brokenFs,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    on(_event: string, listener: Host['listener']): () => void { host.listener = listener; return () => {} },
  } as unknown as Context
  installIntakeGate(ctx, { specRel: SPEC_REL })
  const decision = await host.listener!(userPayload('C:/paper-ws', '帮我写第三章'), enterNext)
  assert.equal(decision.messages!.length, 1, '异常时静默放行')
})

test('闸门：缓存生效（同一 agent 60 秒内不重复读盘）', async () => {
  const host = await bootHost()
  let reads = 0
  const countingFs = {
    async resolve(path: string) { return { displayPath: path } },
    async readText(target: { displayPath: string }) {
      reads += 1
      if (target.displayPath.endsWith('进度台账.md')) return '# 台账'
      const error = new Error('ENOENT') as Error & { code?: string }
      error.code = 'ENOENT'
      throw error
    },
    async writeText() { return { version: 1 } },
    async listDir() { return [] },
    async stat() { return undefined },
  }
  const listenerHost: Host = { ctx: undefined as unknown as Context, fs: host.fs, listener: undefined }
  const ctx = {
    fs: countingFs,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    on(_event: string, listener: Host['listener']): () => void { listenerHost.listener = listener; return () => {} },
  } as unknown as Context
  installIntakeGate(ctx, { specRel: SPEC_REL })
  const payload = userPayload('C:/paper-ws', '帮我写第三章')
  await listenerHost.listener!(payload, enterNext)
  const afterFirst = reads
  await listenerHost.listener!(payload, enterNext)
  assert.equal(reads, afterFirst, '第二次不应再读盘')
})
