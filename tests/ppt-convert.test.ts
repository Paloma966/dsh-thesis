/**
 * `src/ppt/convert.ts` 的单元测试：引擎探测、auto 顺序、失败必抛错、转换指引。
 *
 * 全部通过**注入的 spawn 替身**驱动，不依赖被测机器上是否真的装了 marp/pandoc；
 * 另外保留一条"真实环境探测"的确定性断言（本机无 marp/pandoc 时返回 false，
 * 若恰好装了也只断言不抛错）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  conversionGuide,
  convert,
  detectEngines,
  renderConversionNotes,
  type EngineDetection,
  type SpawnFn,
  type SpawnResult,
} from '../src/ppt/convert.ts'

/** 构造一个 spawn 替身：按命令名返回预设结果，并记录调用顺序。 */
function stubSpawn(table: Record<string, Partial<SpawnResult>>): { spawn: SpawnFn; calls: string[][] } {
  const calls: string[][] = []
  const spawn: SpawnFn = (command, args) => {
    calls.push([command, ...args])
    const preset = table[command]
    if (preset === undefined) {
      return { status: null, stdout: null, stderr: `ENOENT: ${command} not found`, error: new Error(`spawnSync ${command} ENOENT`) }
    }
    return {
      status: preset.status ?? 0,
      stdout: preset.stdout ?? '',
      stderr: preset.stderr ?? '',
      ...(preset.error !== undefined ? { error: preset.error } : {}),
    }
  }
  return { spawn, calls }
}

const NO_ENGINE_TABLE: Record<string, Partial<SpawnResult>> = {}

const DETECTION: EngineDetection = {
  marp: false,
  marpNpx: false,
  pandoc: false,
  versions: {},
  problems: ['marp 不可用：ENOENT', 'npx marp-cli 不可用：ENOENT', 'pandoc 不可用：ENOENT'],
}

test('detectEngines：三种引擎都探测，找不到不是错误（返回 false + problems）', () => {
  const { spawn, calls } = stubSpawn(NO_ENGINE_TABLE)
  const detection = detectEngines(spawn, 10_000)
  assert.deepEqual(
    { marp: detection.marp, marpNpx: detection.marpNpx, pandoc: detection.pandoc },
    { marp: false, marpNpx: false, pandoc: false },
  )
  assert.equal(detection.problems.length, 3)
  assert.deepEqual(
    calls,
    [
      ['marp', '--version'],
      ['npx', '--no-install', '@marp-team/marp-cli', '--version'],
      ['pandoc', '--version'],
    ],
  )
})

test('detectEngines：探测到就记版本首行（探测也有超时）', () => {
  const { spawn, calls } = stubSpawn({
    marp: { status: 0, stdout: '@marp-team/marp-cli v4.0.0\n' },
    npx: { status: 1, stdout: '', stderr: 'npm ERR! not installed' },
    pandoc: { status: 0, stdout: 'pandoc 3.1.9\nCompiled with...' },
  })
  const detection = detectEngines(spawn, 5_000)
  assert.equal(detection.marp, true)
  assert.equal(detection.marpNpx, false)
  assert.equal(detection.pandoc, true)
  assert.equal(detection.versions.marp, '@marp-team/marp-cli v4.0.0')
  assert.equal(detection.versions.pandoc, 'pandoc 3.1.9')
  assert.equal(detection.problems.length, 1)
  assert.match(detection.problems[0]!, /npx/)
  assert.equal(calls.length, 3)
})

test('detectEngines：真实环境探测不抛错，且与"没装就 false"一致', () => {
  const detection = detectEngines()
  assert.equal(typeof detection.marp, 'boolean')
  assert.equal(typeof detection.marpNpx, 'boolean')
  assert.equal(typeof detection.pandoc, 'boolean')
  // 本机实测没有 marp/pandoc；若将来装了，这里也只要求与命令退出码一致。
  if (!detection.marp && !detection.marpNpx && !detection.pandoc) {
    assert.ok(detection.problems.length >= 3)
  }
})

test('convert auto：顺序 marp → npx marp-cli → pandoc，第一个可用即用', () => {
  const detection: EngineDetection = { marp: true, marpNpx: true, pandoc: true, versions: {}, problems: [] }
  const { spawn, calls } = stubSpawn({
    marp: { status: 0, stdout: 'converted' },
  })
  const result = convert('/t/07-答辩/PPT.md', '/t/07-答辩/PPT.pptx', {
    engine: 'auto',
    timeoutMs: 60_000,
    spawn,
    detection,
    exists: () => true,
  })
  assert.equal(result.ok, true)
  assert.equal(result.engine, 'marp')
  assert.equal(result.written, true)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], ['marp', '/t/07-答辩/PPT.md', '--pptx', '--output', '/t/07-答辩/PPT.pptx', '--allow-local-files'])
  assert.equal(result.commands.length, 1)
  assert.equal(result.commands[0]!.ok, true)
})

test('convert auto：marp 失败时降级到 npx，再失败降级到 pandoc（命令与退出码全记录）', () => {
  const detection: EngineDetection = { marp: true, marpNpx: true, pandoc: true, versions: {}, problems: [] }
  const { spawn, calls } = stubSpawn({
    marp: { status: 1, stdout: '', stderr: 'marp: unknown flag --pptx' },
    npx: { status: 1, stdout: '', stderr: 'npm ERR! 404 not found' },
    pandoc: { status: 0, stdout: 'ok' },
  })
  const result = convert('/t/PPT.md', '/t/PPT.pptx', { engine: 'auto', timeoutMs: 1000, spawn, detection, exists: () => true })
  assert.equal(result.engine, 'pandoc')
  assert.deepEqual(calls.map(c => c[0]), ['marp', 'npx', 'pandoc'])
  assert.deepEqual(result.commands.map(c => c.status), [1, 1, 0])
  assert.match(result.commands[0]!.stderr, /unknown flag/)
  assert.equal(result.commands.length, 3)
  assert.ok(result.commands.every(c => c.elapsedMs >= 0))
})

test('convert auto：退出码 0 但没写出文件也算失败，且绝不静默', () => {
  const detection: EngineDetection = { marp: true, marpNpx: false, pandoc: false, versions: {}, problems: [] }
  const { spawn } = stubSpawn({ marp: { status: 0, stdout: 'fake success' } })
  assert.throws(
    () => convert('/t/PPT.md', '/t/PPT.pptx', { engine: 'auto', timeoutMs: 1000, spawn, detection, exists: () => false }),
    /未写出/,
  )
})

test('convert：无任何引擎时抛错，错误里含下一步指引', () => {
  const { spawn, calls } = stubSpawn(NO_ENGINE_TABLE)
  assert.throws(
    () => convert('/t/PPT.md', '/t/PPT.pptx', { engine: 'auto', timeoutMs: 1000, spawn, detection: DETECTION }),
    (error: unknown) => {
      const message = (error as Error).message
      assert.match(message, /未探测到/)
      assert.match(message, /thesis_slides action=guide/)
      return true
    },
  )
  assert.equal(calls.length, 0, '引擎不可用时不应该执行任何命令')
})

test('convert：显式 marp/pandoc/none 的行为与报错原因', () => {
  const onlyPandoc: EngineDetection = { marp: false, marpNpx: false, pandoc: true, versions: {}, problems: [] }
  assert.throws(
    () => convert('/t/PPT.md', '/t/PPT.pptx', { engine: 'marp', timeoutMs: 1000, spawn: stubSpawn(NO_ENGINE_TABLE).spawn, detection: onlyPandoc }),
    /既没有 marp/,
  )
  assert.throws(
    () => convert('/t/PPT.md', '/t/PPT.pptx', { engine: 'pandoc', timeoutMs: 1000, spawn: stubSpawn(NO_ENGINE_TABLE).spawn, detection: DETECTION }),
    /未安装 pandoc/,
  )
  assert.throws(
    () => convert('/t/PPT.md', '/t/PPT.pptx', { engine: 'none', timeoutMs: 1000, spawn: stubSpawn(NO_ENGINE_TABLE).spawn, detection: onlyPandoc }),
    /未探测到/,
  )

  const { spawn, calls } = stubSpawn({ pandoc: { status: 0, stdout: '' } })
  const result = convert('/t/PPT.md', '/t/PPT.pptx', { engine: 'pandoc', timeoutMs: 1000, spawn, detection: onlyPandoc, exists: () => true })
  assert.equal(result.engine, 'pandoc')
  assert.deepEqual(calls[0], ['pandoc', '/t/PPT.md', '-o', '/t/PPT.pptx'])
})

test('convert：引擎存在但全部失败时抛错并带上每个命令的输出摘要', () => {
  const detection: EngineDetection = { marp: true, marpNpx: false, pandoc: true, versions: {}, problems: [] }
  const { spawn } = stubSpawn({
    marp: { status: 2, stderr: 'marp boom' },
    pandoc: { status: 1, stderr: 'pandoc: PPT.md: withBinaryFile: does not exist' },
  })
  assert.throws(
    () => convert('/t/PPT.md', '/t/PPT.pptx', { engine: 'auto', timeoutMs: 1000, spawn, detection, exists: () => false }),
    (error: unknown) => {
      const message = (error as Error).message
      assert.match(message, /均未产出/)
      assert.match(message, /marp boom/)
      assert.match(message, /does not exist/)
      assert.match(message, /退出码 2/)
      return true
    },
  )
})

test('convert：超时会作为失败原因记录', () => {
  const detection: EngineDetection = { marp: true, marpNpx: false, pandoc: false, versions: {}, problems: [] }
  const spawn: SpawnFn = () => ({ status: null, stdout: null, stderr: '', error: new Error('spawnSync marp ETIMEDOUT') })
  assert.throws(
    () => convert('/t/PPT.md', '/t/PPT.pptx', { engine: 'auto', timeoutMs: 10, spawn, detection, exists: () => true }),
    /超时/,
  )
})

test('conversionGuide：同时包含 PowerShell 与 Unix 命令，以及 npx 免安装与手工兜底', () => {
  const guide = conversionGuide('07-答辩/PPT.md', '07-答辩/PPT.pptx', DETECTION)
  assert.match(guide, /```powershell/)
  assert.match(guide, /```bash/)
  assert.match(guide, /Windows PowerShell/)
  assert.match(guide, /macOS \/ Linux/)
  // npx 免安装版
  assert.match(guide, /npx --yes @marp-team\/marp-cli "07-答辩\/PPT\.md" --pptx --output "07-答辩\/PPT\.pptx"/)
  // PowerShell 与 bash 两段都要有同一套命令
  assert.equal((guide.match(/npx --yes @marp-team\/marp-cli/g) ?? []).length >= 2, true)
  assert.match(guide, /marp "07-答辩\/PPT\.md" --pptx/)
  assert.match(guide, /pandoc "07-答辩\/PPT\.md" -o "07-答辩\/PPT\.pptx"/)
  // 手工兜底与离线替代
  assert.match(guide, /marp\.app/)
  assert.match(guide, /WPS 演示|PowerPoint/)
  assert.match(guide, /离线环境的替代方案/)
  assert.match(guide, /三种转换器都不可用/)
})

test('conversionGuide：未探测时也给出完整命令（不阻塞）', () => {
  const guide = conversionGuide('/t/PPT.md', '/t/PPT.pptx')
  assert.match(guide, /未执行探测/)
  assert.match(guide, /npx --yes @marp-team\/marp-cli/)
})

test('renderConversionNotes：记录探测结果与失败原因（未产出 pptx）', () => {
  const notes = renderConversionNotes({
    slidesPath: '/t/07-答辩/PPT.md',
    outPath: '/t/07-答辩/PPT.pptx',
    detection: DETECTION,
    engine: 'auto',
    error: '转换失败：均未产出 /t/07-答辩/PPT.pptx',
    theme: 'default',
    now: new Date('2026-09-12T10:20:30Z'),
  })
  assert.match(notes, /PPT 转换说明/)
  assert.match(notes, /marp（`marp --version`）：不可用/)
  assert.match(notes, /未执行任何转换命令/)
  assert.match(notes, /未产出 pptx/)
  assert.match(notes, /npx --yes @marp-team\/marp-cli/)
})

test('renderConversionNotes：成功时记录命令与输出摘要', () => {
  const result = convert('/t/PPT.md', '/t/PPT.pptx', {
    engine: 'pandoc',
    timeoutMs: 1000,
    spawn: stubSpawn({ pandoc: { status: 0, stdout: 'wrote 12 slides' } }).spawn,
    detection: { marp: false, marpNpx: false, pandoc: true, versions: { pandoc: 'pandoc 3.1.9' }, problems: [] },
    exists: () => true,
  })
  const notes = renderConversionNotes({
    slidesPath: '/t/PPT.md',
    outPath: '/t/PPT.pptx',
    detection: { marp: false, marpNpx: false, pandoc: true, versions: { pandoc: 'pandoc 3.1.9' }, problems: [] },
    engine: 'auto',
    result,
    theme: 'default',
    now: new Date('2026-09-12T10:20:30Z'),
  }, p => p.replace('/t/', ''))
  assert.match(notes, /结果：成功，引擎 pandoc/)
  assert.match(notes, /pandoc \/t\/PPT\.md -o \/t\/PPT\.pptx/)
  assert.match(notes, /wrote 12 slides/)
  assert.match(notes, /退出码：0；耗时：\d+ ms/)
})
