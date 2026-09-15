/**
 * `thesis_slides` 四个动作的端到端（假 fs）测试：落盘路径、不覆盖已有 PPT.md、
 * force 时先备份、check 的问题检出、convert 的说明落盘与失败抛错。
 *
 * 注意：这里直接调用 `src/ppt/actions.ts`（零 cordis 依赖），不 import
 * `src/ppt/index.ts`——后者的 `defineTool` 来自宿主包，运行期由 DSH 装配提供，
 * 离线单测里不存在。工具注册的连线由 `thesis_slides` 的真实验收覆盖。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as nodePath from 'node:path'
import { PPT_RELS, runPptAction, type PptDeps } from '../src/ppt/actions.ts'
import * as commandModule from '../src/ppt/commands.ts'
import { renderMarp } from '../src/ppt/marp.ts'
import { buildSlidePlan } from '../src/ppt/outline.ts'
import type { PptOptions } from '../src/config.ts'
import type { ConversionResult, EngineDetection } from '../src/ppt/convert.ts'
import { FakeFs, FAKE_NOW, MATERIALS_REL, NOTES_REL, ROOT, seedChaptersOnly, seedFullWorkspace } from './ppt-fixtures.ts'

const PPT_OPTIONS: PptOptions = { engine: 'auto', theme: 'default', timeoutMs: 60_000 }

const NO_ENGINE: EngineDetection = {
  marp: false,
  marpNpx: false,
  pandoc: false,
  versions: {},
  problems: ['marp 不可用：ENOENT', 'npx marp-cli 不可用：ENOENT', 'pandoc 不可用：ENOENT'],
}

interface Harness {
  readonly fs: FakeFs
  readonly run: (args: Record<string, unknown>) => Promise<{ text: string; error?: string }>
}

function harness(seed: (fs: FakeFs) => FakeFs = seedFullWorkspace, overrides: PptDeps = {}): Harness {
  const fs = seed(new FakeFs())
  const deps: PptDeps = { detect: () => NO_ENGINE, now: () => FAKE_NOW, ...overrides }
  return {
    fs,
    run: async (args: Record<string, unknown>) => {
      const outcome = await runPptAction(fs, ROOT, args as never, { ppt: PPT_OPTIONS }, undefined, deps)
      return { text: outcome.text, ...(outcome.error !== undefined ? { error: outcome.error } : {}) }
    },
  }
}

test('outline：落盘 07-答辩/PPT.md，返回页数/时长/下一步', async () => {
  const h = harness()
  const { text } = await h.run({ action: 'outline' })
  assert.match(text, /幻灯 Markdown 已生成：07-答辩\/PPT\.md/)
  assert.match(text, /实际页数：11 页（听众：本科）/)
  assert.match(text, /预计时长：\d+-\d+ 分钟（每页 40-60 秒）/)
  assert.match(text, /素材来源：07-答辩\/答辩素材\.md/)
  assert.match(text, /thesis_slides action=convert/)
  const markdown = h.fs.peek(nodePath.join(ROOT, PPT_RELS.slides))
  assert.ok(markdown !== undefined)
  assert.match(markdown, /^---\nmarp: true\n/)
  assert.match(markdown, /## 封面/)
  assert.match(markdown, /<!-- 讲稿：/)
  assert.match(markdown, /<!-- 锚点: /)
})

test('outline → check：生成的幻灯零 error', async () => {
  const h = harness()
  await h.run({ action: 'outline' })
  const { text } = await h.run({ action: 'check' })
  assert.match(text, /幻灯质量检查：07-答辩\/PPT\.md/)
  assert.match(text, /页数：11 页/)
  assert.match(text, /结论：通过（无 error）/)
  assert.doesNotMatch(text, /\[必须修\]/)
})

test('outline：已存在 PPT.md 时默认不覆盖，原文件一字不动', async () => {
  const h = harness()
  const target = nodePath.join(ROOT, PPT_RELS.slides)
  await h.fs.writeText({ displayPath: target }, '# 我手写的幻灯\n\n## 封面\n')
  const { text } = await h.run({ action: 'outline' })
  assert.match(text, /已存在，未覆盖/)
  assert.match(text, /force=true/)
  assert.equal(h.fs.peek(target), '# 我手写的幻灯\n\n## 封面\n')
  assert.equal(h.fs.paths().some(p => /PPT-\d{8}-\d{6}\.md$/.test(p)), false)
})

test('outline：force=true 覆盖前先把旧文件另存为 PPT-<时间戳>.md', async () => {
  const h = harness()
  const target = nodePath.join(ROOT, PPT_RELS.slides)
  const old = '# 我手写的幻灯\n\n## 封面\n- 旧内容\n'
  await h.fs.writeText({ displayPath: target }, old)
  const { text } = await h.run({ action: 'outline', force: true })
  assert.match(text, /旧文件已备份为：07-答辩\/PPT-20260912-102030\.md/)
  assert.equal(h.fs.peek(nodePath.join(ROOT, '07-答辩/PPT-20260912-102030.md')), old)
  const fresh = h.fs.peek(target)!
  assert.match(fresh, /^---\nmarp: true\n/)
  assert.notEqual(fresh, old)
})

test('outline：素材缺失时回退论文章节，并在返回里给出"先跑 thesis_defense"', async () => {
  const h = harness(seedChaptersOnly)
  const { text } = await h.run({ action: 'outline' })
  assert.match(text, /素材来源：06-论文\/章节\/\*\.md（回退）/)
  assert.match(text, /素材未生成，建议先跑 thesis_defense/)
  assert.match(text, /未编造任何系统细节/)
  const markdown = h.fs.peek(nodePath.join(ROOT, PPT_RELS.slides))!
  assert.doesNotMatch(markdown, /Spring Boot/)
  assert.doesNotMatch(markdown, /推荐准确率/)
  assert.match(markdown, /## 系统设计：总体架构/)
  assert.match(markdown, /5\.1 开发环境/)
  assert.match(markdown, /开发环境与关键技术/)
})

test('outline：pages/audience 参数生效（master 档位每页 45-70 秒）', async () => {
  const h = harness()
  const { text } = await h.run({ action: 'outline', pages: 12, audience: 'master' })
  assert.match(text, /实际页数：12 页（听众：硕士）/)
  assert.match(text, /每页 45-70 秒/)
})

test('check：检出页数不足/要点过多/缺讲稿/占位标记等问题并逐条定位', async () => {
  const h = harness()
  const problems = [
    '---',
    'marp: true',
    'theme: default',
    'paginate: true',
    'size: 16:9',
    'header: 坏幻灯',
    'footer: t',
    '---',
    '',
    '## 封面',
    '',
    '- 姓名：＿＿＿（待填） <!-- 锚点: 00-管理/选题/选题确认书.md -->',
    '- 学号：＿＿＿（待填） <!-- 锚点: 00-管理/选题/选题确认书.md -->',
    '- 指导教师：＿＿＿（待填） <!-- 锚点: 00-管理/选题/选题确认书.md -->',
    '',
    '<!-- 讲稿：开场。 -->',
    '',
    '---',
    '',
    '## 这是一个明显超过二十个字符上限的幻灯页标题',
    '',
    '- 一 <!-- 锚点: 03-设计/系统设计.md -->',
    '- 二 <!-- 锚点: 03-设计/系统设计.md -->',
    '- 三 <!-- 锚点: 03-设计/系统设计.md -->',
    '- 四 <!-- 锚点: 03-设计/系统设计.md -->',
    '- 五 <!-- 锚点: 03-设计/系统设计.md -->',
    '- 六 <!-- 锚点: 03-设计/系统设计.md -->',
    '- 七 <!-- 锚点: 03-设计/系统设计.md -->',
    '',
    '<!-- 讲稿：本页有讲稿。 -->',
    '',
    '---',
    '',
    '## 无讲稿页',
    '',
    '- 待补充：这里还没写完 <!-- 锚点: 03-设计/系统设计.md -->',
    '- 没有锚点的要点',
    '- 正常要点 <!-- 锚点: 03-设计/系统设计.md -->',
    '',
  ].join('\n')
  await h.fs.writeText({ displayPath: nodePath.join(ROOT, PPT_RELS.slides) }, problems)
  const { text } = await h.run({ action: 'check' })
  assert.match(text, /少于本科答辩骨架要求的 10-12 页/)
  assert.match(text, /7 条要点，超出每页 6 条上限/)
  assert.match(text, /缺少讲稿要点/)
  assert.match(text, /待补充/)
  assert.match(text, /没有证据锚点/)
  assert.match(text, /超过 20 字上限/)
  assert.match(text, /第 3 页「无讲稿页」/)
  assert.doesNotMatch(text, /结论：通过（无 error）/)
  assert.match(text, /条必须修/)
})

test('check：锚点指向不存在的文件时记 warn（素材未生成的正常提示）', async () => {
  const h = harness()
  await h.run({ action: 'outline' })
  const { text } = await h.run({ action: 'check' })
  assert.match(text, /指向的文件不存在/)
})

test('check：PPT.md 不存在时明确报错，不静默', async () => {
  const h = harness()
  await assert.rejects(() => h.run({ action: 'check' }), /尚未生成。请先运行 thesis_slides action=outline/)
})

test('check：时长超过 12 分钟时报必须修', async () => {
  const plan = buildSlidePlan({
    title: '课题',
    audience: 'master',
    targetPages: 16,
    defenseMaterials: [
      '# 答辩素材',
      '',
      '## 课题',
      '',
      '课题',
      '',
      '## 章节概览',
      '',
      '### 第 1 章 绪论（900 字，引用 1 处）',
      '',
      '- 1.1 研究背景与意义',
      '',
    ].join('\n'),
  })
  const h = harness()
  await h.fs.writeText({ displayPath: nodePath.join(ROOT, PPT_RELS.slides) }, renderMarp(plan, {}))
  const { text } = await h.run({ action: 'check', audience: 'master' })
  assert.match(text, /超出 8-12 分钟的答辩窗口/)
  assert.match(text, /time-over/)
})

test('guide：只输出指引、不落盘任何文件', async () => {
  const h = harness()
  const before = h.fs.paths()
  const { text } = await h.run({ action: 'guide' })
  assert.match(text, /答辩 PPT 转换指引/)
  assert.match(text, /```powershell/)
  assert.match(text, /```bash/)
  assert.match(text, /npx --yes @marp-team\/marp-cli/)
  assert.deepEqual(h.fs.paths(), before)
})

test('convert：没有引擎时报错，但转换说明仍然落盘（含探测结果与确切命令）', async () => {
  const h = harness()
  await h.run({ action: 'outline' })
  await assert.rejects(() => h.run({ action: 'convert' }), /未产出 pptx|未探测到/)
  const notes = h.fs.peek(nodePath.join(ROOT, PPT_RELS.notes))
  assert.ok(notes !== undefined, '转换说明必须落盘')
  assert.match(notes, /PPT 转换说明/)
  assert.match(notes, /marp（`marp --version`）：不可用/)
  assert.match(notes, /npx --yes @marp-team\/marp-cli "07-答辩\/PPT\.md"/)
  assert.match(notes, /未产出 pptx/)
  assert.equal(h.fs.has(nodePath.join(ROOT, PPT_RELS.pptx)), false)
})

test('convert：成功时调用落盘钩子写 PPT.pptx，说明里记录命令与退出码', async () => {
  const writes: { path: string; bytes: number }[] = []
  const fakeResult: ConversionResult = {
    ok: true,
    engine: 'marp',
    slidesPath: nodePath.join(ROOT, PPT_RELS.slides),
    outPath: nodePath.join(ROOT, PPT_RELS.pptx),
    written: true,
    commands: [
      { label: 'marp-cli（本机已安装）', command: 'marp', args: ['PPT.md', '--pptx'], status: 0, ok: true, stdout: 'ok', stderr: '', elapsedMs: 1234, timedOut: false },
    ],
    manualFallback: false,
  }
  const h = harness(seedFullWorkspace, {
    detect: () => ({ marp: true, marpNpx: false, pandoc: false, versions: { marp: 'v4.0.0' }, problems: [] }),
    convert: () => fakeResult,
    writeBinary: async (path, data) => {
      writes.push({ path, bytes: data.length })
    },
  })
  await h.run({ action: 'outline' })
  const { text, error } = await h.run({ action: 'convert' })
  assert.equal(error, undefined)
  assert.match(text, /转换成功：07-答辩\/PPT\.pptx（引擎：marp）/)
  assert.match(text, /探测：marp=可用；npx marp-cli=无；pandoc=无/)
  assert.equal(writes.length, 1)
  assert.equal(writes[0]!.path, nodePath.join(ROOT, PPT_RELS.pptx))
  const notes = h.fs.peek(nodePath.join(ROOT, PPT_RELS.notes))!
  assert.match(notes, /结果：成功，引擎 marp/)
  assert.match(notes, /退出码：0；耗时：1234 ms/)
})

test('convert：转换替身抛错时，工具抛错且说明落盘（绝不假装成功）', async () => {
  const h = harness(seedFullWorkspace, {
    convert: () => {
      throw new Error('转换失败：按 auto 依次尝试了 1 个引擎，均未产出')
    },
  })
  await h.run({ action: 'outline' })
  await assert.rejects(() => h.run({ action: 'convert' }), /均未产出/)
  const notes = h.fs.peek(nodePath.join(ROOT, PPT_RELS.notes))
  assert.ok(notes !== undefined)
  assert.match(notes, /均未产出/)
})

test('未找到论文工作区时报错（cwd 不在仓库内）', async () => {
  const fs = new FakeFs()
  await assert.rejects(
    () => runPptAction(fs, nodePath.join('C:', 'elsewhere'), { action: 'outline' }, { ppt: PPT_OPTIONS }, undefined, { detect: () => NO_ENGINE }),
    /未找到论文工作区/,
  )
})

test('未知 action 时报错并列出可用动作', async () => {
  const h = harness()
  await assert.rejects(() => h.run({ action: 'bogus' }), /未知 action：bogus。可用：outline \| convert \| check \| guide/)
})

test('outline：素材存在时优先于章节回退，且不写转换说明', async () => {
  const h = harness()
  await h.run({ action: 'outline' })
  const markdown = h.fs.peek(nodePath.join(ROOT, PPT_RELS.slides))!
  assert.match(markdown, /实现要点：5\.1 开发环境/)
  assert.match(markdown, /测试用例 24 个/)
  assert.match(markdown, /真实结果：检索性能-2026-04-20\.csv/)
  assert.ok(h.fs.has(nodePath.join(ROOT, MATERIALS_REL)))
  assert.equal(h.fs.has(nodePath.join(ROOT, NOTES_REL)), false, 'outline 不写转换说明')
})

test('/thesis-defense 命令：幻灯侧输入解析（动作/页数/档位/force）', () => {
  const { parsePptCommandInput } = commandModule
  assert.deepEqual(parsePptCommandInput('prepare'), { action: 'outline' })
  assert.deepEqual(parsePptCommandInput('outline'), { action: 'outline' })
  assert.deepEqual(parsePptCommandInput('convert'), { action: 'convert' })
  assert.deepEqual(parsePptCommandInput('check 12 master'), { action: 'check', pages: 12, audience: 'master' })
  assert.deepEqual(parsePptCommandInput('outline 11 force'), { action: 'outline', pages: 11, force: true })
  assert.deepEqual(parsePptCommandInput('guide --force'), { action: 'guide', force: true })
  assert.throws(() => parsePptCommandInput('wat'), /无法识别的参数/)
})

test('/thesis-defense 命令：幻灯侧处理器在假 fs 上跑 outline', async () => {
  const { handlePptCommand } = commandModule
  const fs = seedFullWorkspace(new FakeFs())
  const result = await handlePptCommand(
    fs,
    { ppt: PPT_OPTIONS },
    {
      commandId: 'thesis-defense',
      rawInput: 'prepare',
      signal: { aborted: false },
      agent: { session: { header: { cwd: ROOT } } },
    } as never,
    { detect: () => NO_ENGINE, now: () => FAKE_NOW },
  )
  assert.equal(result.kind, 'success')
  assert.match(result.text ?? '', /幻灯 Markdown 已生成/)
  assert.ok(fs.has(nodePath.join(ROOT, PPT_RELS.slides)))
})
