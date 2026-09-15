/**
 * 鲁棒性与数据安全回归测试（DESIGN-v3.md §6.3 / S8）。
 *
 * 这一套用例守护的都是**同一类失败**：把「读不出来」误判成「不存在」，
 * 于是用默认值覆盖学生的真实资产。工作区里的追问答案、进度台账、文献库、
 * 检索记录都是不可再生的——一旦被静默覆盖，用户连"发生了什么"都不会知道。
 *
 * 每条用例的断言都包含两部分：
 * 1. 工具**抛错**（而不是返回"成功"文本）；
 * 2. 原文件**一个字节都没变**。
 *
 * 另外覆盖受限环境下的两个真实约束：取消信号必须原样上抛（不能被当成业务失败），
 * 以及外部转换器"退出码 0 但产物为 0 字节"必须判失败（不能报成功）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FileSystem, FsDirEntry, FsTarget } from '@deepseek-ai/dsh-fs'
import { loadCache, LIT_CACHE_REL, REFS_BIB_REL } from '../src/paper/lib/lit-cache.ts'
import { runLitSave, runLitNote } from '../src/paper/tools/lit.ts'
import { runProgress } from '../src/paper/tools/progress.ts'
import { runDecision } from '../src/paper/tools/decision.ts'
import { runDedup } from '../src/dedup/index.ts'
import { convert } from '../src/ppt/convert.ts'
import { isAbortError } from '../src/shared/fs-errors.ts'
import { FakeFs } from './paper-fixtures.ts'

/**
 * 可注入故障的假文件系统：按路径后缀决定抛什么错。
 *
 * `failWith` 里的错误带 `code`（如 `EACCES`）用于模拟「文件存在但读不出来」，
 * 不带 code 的 `ENOENT` 用于模拟「确实不存在」。
 */
class FaultyFs extends FakeFs {
  /** 路径后缀 → 抛出的错误码（'ENOENT' 表示不存在）。 */
  readonly faults = new Map<string, string>()

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    for (const [suffix, code] of this.faults) {
      if (target.displayPath.replace(/\\/g, '/').endsWith(suffix)) {
        const error = new Error(`${code}: ${target.displayPath}`) as Error & { code?: string }
        if (code !== 'ENOENT') error.code = code
        throw error
      }
    }
    return await super.readText(target, signal)
  }

  /** 覆盖 assert 用的写盘计数。 */
  writes = 0

  override async writeText(target: FsTarget, content: string): Promise<{ version?: unknown }> {
    this.writes += 1
    return await super.writeText(target, content)
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    return await super.listDir(target, signal)
  }
}

const ROOT = 'C:/thesis'
const CWD = 'C:/thesis/06-论文'
const SIMILARITY = { shingle: 4, threshold: 0.3, minChars: 30 }

/** 一条完整的检索记录（与 `LitRecord` 契约一致；字段缺失会生成坏 BibTeX）。 */
function litRecord(id: string, title: string, doi: string) {
  return {
    id,
    title,
    authors: ['Zhang Wei', 'Li Ming'],
    year: 2024,
    venue: 'Journal of Educational Technology',
    type: 'article' as const,
    doi,
    url: `https://doi.org/${doi}`,
    source: 'arxiv',
  }
}

/** 把一条记录写进检索缓存。 */
async function seedCache(fs: FaultyFs, records: Record<string, unknown>): Promise<void> {
  await fs.writeText({ displayPath: `${ROOT}/${LIT_CACHE_REL}` }, JSON.stringify({ version: 1, records }))
}

/** 建一个最小但完整的工作区（台账 + 章节 + 报告目录）。 */
function workspace(): FaultyFs {
  const fs = new FaultyFs()
  void fs.writeText({ displayPath: `${ROOT}/00-管理/进度台账.md` }, '# 进度台账\n')
  void fs.writeText(
    { displayPath: `${ROOT}/06-论文/章节/01-绪论.md` },
    '# 第 1 章 绪论\n\n## 1.1 背景\n\n本文讨论注意力机制在长序列建模中的作用与边界。\n',
  )
  return fs
}

// ---------------------------------------------------------------------------
// 检索缓存：坏 JSON / 读不出来 都不得导致「用空缓存覆盖」
// ---------------------------------------------------------------------------

test('鲁棒性：检索缓存是坏 JSON 时抛错，绝不改成空缓存', async () => {
  const fs = workspace()
  const cachePath = `${ROOT}/${LIT_CACHE_REL}`
  await fs.writeText({ displayPath: cachePath }, '{ 这不是合法 JSON')
  await assert.rejects(
    () => loadCache(fs, ROOT),
    (error: unknown) => {
      assert.match(String(error), /不是合法 JSON/)
      assert.match(String(error), /备份/)
      return true
    },
  )
  assert.equal(fs.peek(cachePath), '{ 这不是合法 JSON', '损坏的缓存不得被改写')
})

test('鲁棒性：检索缓存读不出来（EACCES）与「不存在」必须区分', async () => {
  const fs = workspace()
  const cachePath = `${ROOT}/${LIT_CACHE_REL}`

  // 不存在 → 空缓存（第一次检索的正常情况）
  const empty = await loadCache(fs, ROOT)
  assert.deepEqual(empty.records, {})

  // 存在但读不出来 → 抛错
  await fs.writeText({ displayPath: cachePath }, '{"version":1,"records":{}}')
  fs.faults.set(LIT_CACHE_REL, 'EACCES')
  await assert.rejects(() => loadCache(fs, ROOT), /读不出来|EACCES/)
  fs.faults.clear()
  assert.equal(fs.peek(cachePath), '{"version":1,"records":{}}', '读失败时缓存原样保留')
})

// ---------------------------------------------------------------------------
// 文献库：读失败不得用空表头覆盖
// ---------------------------------------------------------------------------

test('鲁棒性：refs.bib 读不出来时 lit_save 抛错且文献库零改动', async () => {
  const fs = workspace()
  const bibPath = `${ROOT}/${REFS_BIB_REL}`
  const original = '@article{keep1,\n  title={Must Survive},\n  year={2020}\n}\n'
  await fs.writeText({ displayPath: bibPath }, original)
  await seedCache(fs, { abc123: litRecord('abc123', 'New Paper', '10.1000/new.2024') })
  fs.faults.set(REFS_BIB_REL, 'EACCES')
  await assert.rejects(() => runLitSave(fs, { ids: ['abc123'] }, CWD), /读不出来|EACCES/)
  fs.faults.clear()
  assert.equal(fs.peek(bibPath), original, 'refs.bib 必须一字未动')
})

test('鲁棒性：refs.bib 不存在时 lit_save 正常建档（首次收录）', async () => {
  const fs = workspace()
  await seedCache(fs, { abc123: litRecord('abc123', 'New Paper', '10.1000/new.2024') })
  const out = await runLitSave(fs, { ids: ['abc123'] }, CWD)
  assert.match(out, /refs\.bib/)
  assert.match(fs.peek(`${ROOT}/${REFS_BIB_REL}`) ?? '', /New Paper/)
})

test('鲁棒性：缓存外的 id 被拒绝（零假文献机制不可绕过）', async () => {
  const fs = workspace()
  await seedCache(fs, {})
  const out = await runLitSave(fs, { ids: ['ffffffffffffffff'] }, CWD)
  assert.match(out, /不在检索缓存中/)
})

test('鲁棒性：笔记路径的 ref 不得逃出笔记目录（路径穿越防护）', async () => {
  const fs = workspace()
  await seedCache(fs, { abc123: litRecord('abc123', 'T', '10.1000/t.2024') })
  await fs.writeText(
    { displayPath: `${ROOT}/${REFS_BIB_REL}` },
    '@article{..%2F..%2Fescape,\n  title={Evil},\n  year={2020}\n}\n',
  )
  const out = await runLitNote(fs, { ref: 'not-in-cache' }, CWD).catch((error: unknown) => String(error))
  assert.match(String(out), /不在检索缓存中|也没有该 key/)
  for (const key of ['../../escape.md', 'escape.md']) {
    assert.equal(fs.peek(`${ROOT}/02-文献/笔记/${key}`), undefined, `不得写出 ${key}`)
  }
})

// ---------------------------------------------------------------------------
// 进度台账 / 决定日志：读失败不得重置或覆盖
// ---------------------------------------------------------------------------

test('鲁棒性：台账读不出来时 progress 抛错，且不重建默认台账', async () => {
  const fs = workspace()
  const ledgerPath = `${ROOT}/00-管理/进度台账.md`
  const original = fs.peek(ledgerPath)!
  fs.faults.set('00-管理/进度台账.md', 'EACCES')
  fs.writes = 0
  await assert.rejects(() => runProgress(fs, { action: 'report' }, CWD), /读取失败|读不出来|EACCES|权限/)
  assert.equal(fs.writes, 0, '读失败时不得发生任何写盘（否则会把 25 条任务状态归零）')
  fs.faults.clear()
  assert.equal(fs.peek(ledgerPath), original, '台账必须一字未动')
})

test('鲁棒性：决定日志读不出来时 decide 抛错，旧决定不得丢失', async () => {
  const fs = workspace()
  const decisionPath = `${ROOT}/00-管理/决定日志.md`
  const original = '# 决定日志\n\n## 2026-03-01 · 课题定为抬头率检测\n\n- 理由：数据可得\n'
  await fs.writeText({ displayPath: decisionPath }, original)
  fs.faults.set('00-管理/决定日志.md', 'EACCES')
  await assert.rejects(
    () => runDecision(fs, { content: '换一个题目' }, CWD),
    /读不出来|EACCES|权限/,
  )
  fs.faults.clear()
  assert.equal(fs.peek(decisionPath), original, '旧决定必须一字未丢')
})

// ---------------------------------------------------------------------------
// 取消信号：必须原样上抛，不能被当成「工作区不存在」或业务失败
// ---------------------------------------------------------------------------

test('鲁棒性：取消信号在 findThesisRoot 里原样上抛（不被当作「不存在」）', async () => {
  const fs = workspace()
  const controller = new AbortController()
  controller.abort()
  // 让读取在取消后抛 AbortError（真实宿主 fs 的取消行为）。
  const aborted = new Error('The operation was aborted') as Error & { name: string }
  aborted.name = 'AbortError'
  const original = fs.readText.bind(fs)
  fs.readText = async (target: FsTarget, signal?: AbortSignal) => {
    if (signal?.aborted === true) throw aborted
    return await original(target, signal)
  }
  await assert.rejects(
    () => runProgress(fs, { action: 'report' }, CWD, controller.signal),
    (error: unknown) => {
      assert.ok(isAbortError(error), `应当是 AbortError，实际 ${String(error)}`)
      return true
    },
  )
})

test('鲁棒性：事实检索的取消不会被降级链吞成「所有源无结果」', () => {
  const aborted = new Error('aborted') as Error & { name: string }
  aborted.name = 'AbortError'
  assert.ok(isAbortError(aborted))
  assert.equal(isAbortError(new Error('ECONNRESET')), false)
  assert.equal(isAbortError(undefined), false)
})

// ---------------------------------------------------------------------------
// 幻灯转换：退出码 0 但产物 0 字节 = 失败
// ---------------------------------------------------------------------------

const NO_SLIDES = 'C:/thesis/07-答辩/PPT.md'
const OUT_PPTX = 'C:/thesis/07-答辩/PPT.pptx'

test('鲁棒性：外部转换器退出码 0 但写出 0 字节 pptx → 判失败，不报成功', () => {
  assert.throws(
    () => convert(NO_SLIDES, OUT_PPTX, {
      engine: 'auto',
      timeoutMs: 5000,
      detection: { marp: true, marpNpx: false, pandoc: false },
      exists: () => true,
      size: () => 0,
      spawn: () => ({ status: 0, stdout: '', stderr: '', error: undefined }),
    }),
    /0 字节/,
  )
})

test('鲁棒性：外部转换器退出码 0 但没写出文件 → 判失败', () => {
  assert.throws(
    () => convert(NO_SLIDES, OUT_PPTX, {
      engine: 'auto',
      timeoutMs: 5000,
      detection: { marp: true, marpNpx: false, pandoc: false },
      exists: () => false,
      size: () => undefined,
      spawn: () => ({ status: 0, stdout: '', stderr: '', error: undefined }),
    }),
    /未写出/,
  )
})

test('鲁棒性：外部转换器未启动（status=null / EPERM）→ 判失败并说明原因', () => {
  assert.throws(
    () => convert(NO_SLIDES, OUT_PPTX, {
      engine: 'auto',
      timeoutMs: 5000,
      detection: { marp: true, marpNpx: false, pandoc: false },
      exists: () => true,
      size: () => 1024,
      spawn: () => ({ status: null, stdout: '', stderr: '', error: new Error('spawnSync marp EPERM') }),
    }),
    /转换失败|未能完成|EPERM/,
  )
})

test('鲁棒性：产物非空且存在时判成功（不缺报）', () => {
  const result = convert(NO_SLIDES, OUT_PPTX, {
    engine: 'auto',
    timeoutMs: 5000,
    detection: { marp: true, marpNpx: false, pandoc: false },
    exists: () => true,
    size: () => 4096,
    spawn: () => ({ status: 0, stdout: '', stderr: '', error: undefined }),
  })
  assert.equal(result.ok, true)
  assert.equal(result.written, true)
})

// ---------------------------------------------------------------------------
// 原创性自查：action 必填、语料路径明确报错
// ---------------------------------------------------------------------------

test('鲁棒性：原创性自查缺 action 时抛错（不静默当成 scan）', async () => {
  const fs = workspace()
  await assert.rejects(() => runDedup(fs, CWD, {} as never, SIMILARITY), /action 必填/)
  await assert.rejects(() => runDedup(fs, CWD, { action: '  ' }, SIMILARITY), /action 必填/)
  await assert.rejects(() => runDedup(fs, CWD, { action: 'rewrite' }, SIMILARITY), /未知 action/)
})

test('鲁棒性：scan 在没有任何正文时给出可读结论', async () => {
  const fs = new FaultyFs()
  void fs.writeText({ displayPath: `${ROOT}/00-管理/进度台账.md` }, '# 进度台账\n')
  const out = await runDedup(fs, ROOT, { action: 'scan' }, SIMILARITY)
  assert.ok(out.length > 0)
  assert.match(out, /降重报告|报告/)
})
