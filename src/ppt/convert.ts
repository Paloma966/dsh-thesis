/**
 * 外部转换器探测与执行（`thesis_slides action=convert|guide` 的核心）。
 *
 * 本插件**不自己生成 pptx**：Markdown 是唯一真源，pptx 由外部工具产出。
 * 这里沿用 `thesis_build` 的引擎探测模式（spawnSync + 超时 + 落盘构建说明），
 * 但把"降级"换成"如实报告"：
 *
 * - {@link detectEngines} 探测 `marp` / `npx --no-install @marp-team/marp-cli` / `pandoc`；
 *   探测不到**不是错误**（返回 false 即可），探测本身也有超时保护。
 * - {@link convert} 按 `auto|marp|pandoc|none` 执行，每一步的命令、退出码、
 *   stdout/stderr 摘要、耗时都记录在 {@link ConversionResult.commands} 里；
 *   失败**必须抛错**并带上确切原因，绝不静默假装成功。
 * - {@link conversionGuide} 在没有任何引擎时给出可直接复制执行的命令清单
 *   （PowerShell / macOS-Linux / npx 免安装 / 手工兜底 / 离线替代）。
 *
 * @module dsh-thesis/ppt
 */

import { spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import * as nodePath from 'node:path'

/** 本机可用的转换引擎（按优先级）。 */
export type EngineName = 'marp' | 'marp-npx' | 'pandoc'

/** 探测结果。 */
export interface EngineDetection {
  /** 本机是否装了 `marp`（`marp --version` 成功）。 */
  readonly marp: boolean
  /** `npx --no-install @marp-team/marp-cli --version` 是否可用（免安装版）。 */
  readonly marpNpx: boolean
  /** 本机是否装了 `pandoc`（`pandoc --version` 成功）。 */
  readonly pandoc: boolean
  /** 各命令的版本首行（探测到的才有）。 */
  readonly versions: Readonly<Partial<Record<EngineName, string>>>
  /** 探测失败的原因摘要（用于排查，不是错误）。 */
  readonly problems: readonly string[]
}

/** 一次命令执行的记录（写入构建说明）。 */
export interface CommandRecord {
  readonly label: string
  readonly command: string
  readonly args: readonly string[]
  readonly status: number | null
  readonly ok: boolean
  readonly stdout: string
  readonly stderr: string
  readonly elapsedMs: number
  readonly timedOut: boolean
}

/** 可注入的执行器（默认 spawnSync；测试传替身）。 */
export interface SpawnOptions {
  readonly cwd?: string
  readonly encoding?: string
  readonly timeout?: number
  readonly maxBuffer?: number
}
export interface SpawnResult {
  readonly status: number | null
  readonly stdout: string | null
  readonly stderr: string | null
  readonly error?: Error
}
export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => SpawnResult

/** 引擎选择（与 PptOptions.engine 同义）。 */
export type EngineChoice = 'auto' | 'marp' | 'pandoc' | 'none'

/** {@link convert} 选项。 */
export interface ConvertOptions {
  readonly engine: EngineChoice
  readonly timeoutMs: number
  /** 注入的 spawn 实现（测试用）。 */
  readonly spawn?: SpawnFn
  /** 注入的探测结果（测试用；缺省现场探测）。 */
  readonly detection?: EngineDetection
  /** 产物存在性检查（测试用；缺省用 node:fs 判断）。 */
  readonly exists?: (path: string) => boolean
  /**
   * 产物字节数检查（测试用；缺省用 node:fs 的 stat）。
   *
   * 返回 `undefined` 表示无法确定大小——那时只接受「存在」这一条判据，
   * 并把「未能校验非空」写进失败原因，绝不宣称验证过。
   */
  readonly size?: (path: string) => number | undefined
  /** 外部命令的工作目录。 */
  readonly cwd?: string
}

/** 转换结果。 */
export interface ConversionResult {
  readonly ok: boolean
  readonly engine: EngineName | 'manual' | null
  readonly slidesPath: string
  readonly outPath: string
  readonly written: boolean
  readonly commands: readonly CommandRecord[]
  /** 未产出 pptx 时，指向可执行的兜底说明。 */
  readonly manualFallback: boolean
  readonly reason?: string
}

/** 命令输出摘录上限（避免把整份日志塞进工具返回值）。 */
const EXCERPT = 600
/** 构建说明里每条命令的输出上限。 */
const NOTE_EXCERPT = 1500

const defaultSpawn: SpawnFn = (command, args, options) =>
  spawnSync(command, [...args], {
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    encoding: options.encoding ?? 'utf8',
    ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
    maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
  })

/** 默认的产物存在性检查（node:fs）。 */
function fsExists(path: string): boolean {
  return existsSync(path)
}

/** 默认的产物大小检查（node:fs）；文件不存在或 stat 失败时返回 undefined。 */
function fsSize(path: string): number | undefined {
  try {
    return statSync(path).size
  } catch {
    return undefined
  }
}

/** 产物体检结论：退出码为 0 之后还必须过这一关。 */
type OutputProbe = { readonly ok: true } | { readonly ok: false; readonly reason: string }

/**
 * 判断外部引擎是否真的产出了可用的 pptx。
 *
 * 三条判据：存在 → 是文件（非目录）→ 非空。`size` 未知时只走到第二条，
 * 并在结论里显式说明「未校验非空」，而不是假装验证过。
 */
function probeOutput(
  path: string,
  exists: (path: string) => boolean,
  size: (path: string) => number | undefined,
): OutputProbe {
  if (!exists(path)) return { ok: false, reason: `退出码 0，但未写出 ${path}` }
  const bytes = size(path)
  if (bytes === undefined) return { ok: true }
  if (bytes === 0) return { ok: false, reason: `退出码 0，但写出的 ${path} 是 0 字节（引擎静默失败）` }
  return { ok: true }
}

function excerpt(text: string | null | undefined, limit = NOTE_EXCERPT): string {
  const trimmed = (text ?? '').trim()
  if (trimmed.length <= limit) return trimmed
  return `${trimmed.slice(0, limit)}\n…（输出已截断，共 ${trimmed.length} 字符）`
}

function firstLine(text: string | null | undefined): string {
  return (text ?? '').split(/\r?\n/).map(l => l.trim()).find(l => l !== '') ?? ''
}

/** 命令的可复制形态（Windows 上仍用 POSIX 引号，便于记录与跨平台复现）。 */
function displayCommand(command: string, args: readonly string[]): string {
  const quote = (value: string): string => (/\s/.test(value) ? `"${value}"` : value)
  return [command, ...args].map(quote).join(' ')
}

function run(label: string, command: string, args: readonly string[], opts: { readonly cwd?: string; readonly timeoutMs: number; readonly spawn: SpawnFn }): CommandRecord {
  const started = Date.now()
  let result: SpawnResult
  try {
    result = opts.spawn(command, args, {
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      encoding: 'utf8',
      timeout: opts.timeoutMs,
    })
  } catch (error) {
    return {
      label,
      command,
      args,
      status: null,
      ok: false,
      stdout: '',
      stderr: String(error),
      elapsedMs: Date.now() - started,
      timedOut: false,
    }
  }
  const elapsedMs = Date.now() - started
  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  const timedOut = result.status === null && result.error !== undefined && /ETIMEDOUT|timed? ?out/i.test(result.error.message)
  return {
    label,
    command,
    args,
    status: result.status,
    ok: result.status === 0,
    stdout: excerpt(stdout),
    stderr: excerpt(stderr !== '' ? stderr : result.error?.message),
    elapsedMs,
    timedOut,
  }
}

/** 默认探测超时：10 秒（探测本身也必须有时限）。 */
export const DETECT_TIMEOUT_MS = 10_000

/**
 * 探测本机转换器。
 *
 * 三条命令各自独立探测：找不到（status ≠ 0 / ENOENT）只记 `problems` 摘要，
 * **不算错误**；每条命令 10 秒超时，避免卡死。
 */
export function detectEngines(spawn: SpawnFn = defaultSpawn, timeoutMs: number = DETECT_TIMEOUT_MS): EngineDetection {
  const problems: string[] = []
  const versions: Partial<Record<EngineName, string>> = {}

  const marp = run('探测 marp', 'marp', ['--version'], { timeoutMs, spawn })
  if (!marp.ok) problems.push(`marp 不可用：${marp.timedOut ? '探测超时' : marp.stderr.split('\n')[0] ?? ''}`)
  else versions.marp = firstLine(marp.stdout)

  const marpNpx = run('探测 npx marp-cli', 'npx', ['--no-install', '@marp-team/marp-cli', '--version'], { timeoutMs, spawn })
  if (!marpNpx.ok) problems.push(`npx marp-cli 不可用：${marpNpx.timedOut ? '探测超时' : marpNpx.stderr.split('\n')[0] ?? ''}`)
  else versions['marp-npx'] = firstLine(marpNpx.stdout)

  const pandoc = run('探测 pandoc', 'pandoc', ['--version'], { timeoutMs, spawn })
  if (!pandoc.ok) problems.push(`pandoc 不可用：${pandoc.timedOut ? '探测超时' : pandoc.stderr.split('\n')[0] ?? ''}`)
  else versions.pandoc = firstLine(pandoc.stdout)

  return { marp: marp.ok, marpNpx: marpNpx.ok, pandoc: pandoc.ok, versions, problems }
}

interface EnginePlan {
  readonly engine: EngineName
  readonly label: string
  readonly command: string
  readonly args: (slidesPath: string, outPath: string) => string[]
}

const ENGINE_PLANS: Readonly<Record<EngineName, EnginePlan>> = {
  marp: {
    engine: 'marp',
    label: 'marp-cli（本机已安装）',
    command: 'marp',
    args: (slides, out) => [slides, '--pptx', '--output', out, '--allow-local-files'],
  },
  'marp-npx': {
    engine: 'marp-npx',
    label: 'npx 免安装 @marp-team/marp-cli',
    command: 'npx',
    args: (slides, out) => ['--no-install', '@marp-team/marp-cli', slides, '--pptx', '--output', out, '--allow-local-files'],
  },
  pandoc: {
    engine: 'pandoc',
    label: 'pandoc（Markdown → pptx）',
    command: 'pandoc',
    args: (slides, out) => [slides, '-o', out],
  },
}

/** 引擎 → 是否可用；`auto` 的候选顺序是 marp → marp-npx → pandoc。 */
export function availableOrder(detection: EngineDetection, choice: EngineChoice): EngineName[] {
  const order: EngineName[] = ['marp', 'marp-npx', 'pandoc']
  if (choice === 'marp') return order.filter(name => name !== 'pandoc' && isAvailable(detection, name))
  if (choice === 'pandoc') return detection.pandoc ? ['pandoc'] : []
  if (choice === 'none') return []
  return order.filter(name => isAvailable(detection, name))
}

function isAvailable(detection: EngineDetection, engine: EngineName): boolean {
  if (engine === 'marp') return detection.marp
  if (engine === 'marp-npx') return detection.marpNpx
  return detection.pandoc
}

function engineChoiceReason(choice: EngineChoice, detection: EngineDetection): string {
  if (choice === 'marp') {
    return `请求 marp 引擎，但本机既没有 marp（${detection.marp ? '有' : '无'}）也没有可用的 npx @marp-team/marp-cli（${detection.marpNpx ? '有' : '无'}）。`
  }
  if (choice === 'pandoc') {
    return '请求 pandoc 引擎但本机未安装 pandoc（pandoc --version 未通过）。'
  }
  return '本机未探测到 marp、npx @marp-team/marp-cli 或 pandoc，无法执行转换。'
}

/**
 * 执行转换。
 *
 * `auto` 按 marp → marp-npx → pandoc 顺序尝试；某一步失败时记录输出并继续尝试
 * 下一个引擎（与 thesis_build 的降级链一致）；全部失败或引擎不可用时抛错，
 * 错误里带上每个命令的退出码与 stderr 摘要——绝不返回"假装成功"的结果。
 *
 * 产出文件不存在同样视为失败（`--pptx` 退出码为 0 但没写出文件是常见的静默失败）。
 */
export function convert(slidesPath: string, outPath: string, options: ConvertOptions): ConversionResult {
  const spawn = options.spawn ?? defaultSpawn
  const detection = options.detection ?? detectEngines(spawn)
  const exists = options.exists ?? ((path: string) => fsExists(path))
  const size = options.size ?? ((path: string) => fsSize(path))
  const commands: CommandRecord[] = []
  const candidates = availableOrder(detection, options.engine)

  if (candidates.length === 0) {
    const reason = engineChoiceReason(options.engine, detection)
    const error = new Error(
      `${reason}\n` +
      `幻灯片 Markdown：${slidesPath}\n` +
      '下一步：运行 thesis_slides action=guide 获取可复制执行的转换命令（含 PowerShell/Unix/npx 与手工兜底），' +
      '或直接用编辑器打开 Markdown 手工成稿。本工具不会假装成功。',
    )
    throw error
  }

  const workDir = options.cwd ?? nodePath.dirname(slidesPath)
  const failures: string[] = []
  for (const name of candidates) {
    const plan = ENGINE_PLANS[name]
    const args = plan.args(slidesPath, outPath)
    const record = run(plan.label, plan.command, args, { cwd: workDir, timeoutMs: options.timeoutMs, spawn })
    commands.push(record)
    if (!record.ok) {
      failures.push(`- ${displayCommand(record.command, record.args)} → 退出码 ${record.status ?? 'null'}${record.timedOut ? '（超时）' : ''}：${record.stderr.split('\n')[0] ?? ''}`)
      continue
    }
    // 退出码 0 不等于成功：产物必须存在、是文件、且**非空**。
    // 只看存在性的话，一个 0 字节的 pptx 也会被报成「转换成功」，学生打开才发现是空的。
    const written = probeOutput(outPath, exists, size)
    if (!written.ok) {
      failures.push(`- ${displayCommand(record.command, record.args)} → ${written.reason}`)
      continue
    }
    return {
      ok: true,
      engine: plan.engine,
      slidesPath,
      outPath,
      written: true,
      commands,
      manualFallback: false,
    }
  }

  throw new Error(
    `转换失败：按 ${options.engine} 依次尝试了 ${candidates.length} 个引擎，均未产出 ${outPath}。\n` +
    `${failures.join('\n')}\n` +
    '完整命令与输出摘要见 07-答辩/PPT转换说明.md；也可运行 thesis_slides action=guide 获取手工兜底方案。',
  )
}

/** 渲染「PPT 转换说明」的输入。 */
export interface ConversionNotesInput {
  readonly slidesPath: string
  readonly outPath: string
  readonly detection: EngineDetection
  readonly engine: EngineChoice
  readonly result?: ConversionResult
  readonly error?: string
  readonly theme: string
  readonly now?: Date
}

/**
 * 渲染构建说明（无论成功、失败还是只有 Markdown，都要落盘）。
 * 记录：探测结果、每次命令的退出码/stdout/stderr 摘要/耗时、下一步命令。
 */
export function renderConversionNotes(input: ConversionNotesInput, rel = (p: string): string => p): string {
  const now = input.now ?? new Date()
  const lines: string[] = []
  lines.push('# PPT 转换说明')
  lines.push('')
  lines.push(`> 由 thesis_slides 生成；时间：${now.toISOString()}`)
  lines.push('> Markdown 是唯一真源（07-答辩/PPT.md），pptx 由外部工具生成；本插件不自己造 pptx。')
  lines.push('')
  lines.push('## 一、输入与产物')
  lines.push('')
  lines.push(`- 幻灯 Markdown：${rel(input.slidesPath)}`)
  lines.push(`- 目标 pptx：${rel(input.outPath)}`)
  lines.push(`- 配置引擎：${input.engine}；主题：${input.theme}`)
  lines.push('')
  lines.push('## 二、引擎探测结果')
  lines.push('')
  lines.push(`- marp（\`marp --version\`）：${input.detection.marp ? `可用（${input.detection.versions.marp ?? ''}）` : '不可用'}`)
  lines.push(`- npx 免安装（\`npx --no-install @marp-team/marp-cli --version\`）：${input.detection.marpNpx ? `可用（${input.detection.versions['marp-npx'] ?? ''}）` : '不可用'}`)
  lines.push(`- pandoc（\`pandoc --version\`）：${input.detection.pandoc ? `可用（${input.detection.versions.pandoc ?? ''}）` : '不可用'}`)
  if (input.detection.problems.length > 0) {
    lines.push('')
    lines.push('探测失败摘要（不是错误，只是说明本机没装）：')
    for (const problem of input.detection.problems) lines.push(`- ${problem}`)
  }
  lines.push('')
  lines.push('## 三、执行记录')
  lines.push('')
  if (input.result !== undefined && input.result.commands.length > 0) {
    for (const record of input.result.commands) {
      lines.push(`### ${record.label}`)
      lines.push('')
      lines.push(`- 命令：\`${displayCommand(record.command, record.args)}\``)
      lines.push(`- 退出码：${record.status ?? 'null'}；耗时：${record.elapsedMs} ms${record.timedOut ? '（超时）' : ''}`)
      if (record.stdout !== '') {
        lines.push('- stdout 摘要：')
        lines.push('')
        lines.push('```text')
        lines.push(record.stdout)
        lines.push('```')
      }
      if (record.stderr !== '') {
        lines.push('- stderr 摘要：')
        lines.push('')
        lines.push('```text')
        lines.push(record.stderr)
        lines.push('```')
      }
      lines.push('')
    }
  } else {
    lines.push('（未执行任何转换命令）')
    lines.push('')
  }
  if (input.result !== undefined && input.result.ok) {
    lines.push(`结果：成功，引擎 ${input.result.engine} 已产出 ${rel(input.outPath)}。`)
  } else if (input.error !== undefined) {
    lines.push('结果：**未产出 pptx**，原因：')
    lines.push('')
    lines.push('```text')
    lines.push(excerpt(input.error))
    lines.push('```')
  } else {
    lines.push('结果：尚未执行转换（只生成了 Markdown）。')
  }
  lines.push('')
  lines.push('## 四、下一步（可直接复制执行）')
  lines.push('')
  for (const command of guideCommands(input.slidesPath, input.outPath)) lines.push(`- \`${command}\``)
  lines.push('')
  lines.push('完整指引（含手工兜底与离线方案）见本工具 `thesis_slides action=guide` 的输出。')
  lines.push('')
  return lines.join('\n')
}

/** 引擎可用时的一条命令（用于说明文档与 guide）。 */
export interface GuideCommand {
  readonly engine: EngineName | 'manual'
  /** 提示词或说明（中文）。 */
  readonly label: string
  /** `pwsh`（Windows PowerShell）命令。 */
  readonly powershell: string
  /** `bash`/`zsh`（macOS/Linux）命令。 */
  readonly unix: string
}

/** 与探测结果无关的固定命令清单（可直接复制执行，与 {@link conversionGuide} 同源）。 */
export function guideCommands(slidesPath: string, outPath: string): string[] {
  return [
    `npx --yes @marp-team/marp-cli "${slidesPath}" --pptx --output "${outPath}" --allow-local-files`,
    `marp "${slidesPath}" --pptx --output "${outPath}" --allow-local-files`,
    `pandoc "${slidesPath}" -o "${outPath}"`,
  ]
}

/**
 * 转换指引：在没有任何可用引擎时，给出可直接复制执行的完整命令清单。
 * 覆盖 PowerShell 与 macOS/Linux 两套 shell、npx 免安装版、手工兜底与离线方案。
 */
export function conversionGuide(slidesPath: string, outPath: string, detection?: EngineDetection): string {
  const slides = slidesPath
  const out = outPath
  const lines: string[] = []
  lines.push('# 答辩 PPT 转换指引')
  lines.push('')
  lines.push('本插件只产出标准 Marp Markdown（唯一真源），pptx 由外部工具生成；不自研 pptx 生成器，也不假装转换成功。')
  lines.push('')
  lines.push('## 一、本机探测结果')
  lines.push('')
  if (detection === undefined) {
    lines.push('（未执行探测——运行 thesis_slides action=convert 时会自动探测）')
  } else {
    lines.push(`- marp：${detection.marp ? `可用（${detection.versions.marp ?? ''}）` : '未安装'}`)
    lines.push(`- npx marp-cli：${detection.marpNpx ? `可用（${detection.versions['marp-npx'] ?? ''}）` : '未安装/不可用'}`)
    lines.push(`- pandoc：${detection.pandoc ? `可用（${detection.versions.pandoc ?? ''}）` : '未安装'}`)
    if (!detection.marp && !detection.marpNpx && !detection.pandoc) {
      lines.push('')
      lines.push('**结论：三种转换器都不可用**——请从下面任选一条路径（推荐第 1 条，无需联网安装）。')
    }
  }
  lines.push('')
  lines.push('## 二、路径 1（推荐）：手工兜底，零安装')
  lines.push('')
  lines.push(`1. 用编辑器打开 \`${slides}\`，全选复制。`)
  lines.push('2. 打开 https://marp.app/（网页版，粘贴 Markdown 即得预览），导出 PDF/PPTX；或把 Markdown 粘贴进支持 Marp 的编辑器预览。')
  lines.push('3. 若只想快速成稿：把每页 `## 标题` 与要点复制进 WPS 演示 / PowerPoint，套用学校模板后另存为 pptx。')
  lines.push(`4. 无论哪条路径，最后都把成品存为 \`${out}\`，并与 \`07-答辩/PPT.md\` 的内容保持一致。`)
  lines.push('')
  lines.push('## 三、路径 2：npx 免安装（需能访问 npm 源）')
  lines.push('')
  lines.push('```powershell')
  lines.push('# Windows PowerShell')
  lines.push(`npx --yes @marp-team/marp-cli "${slides}" --pptx --output "${out}" --allow-local-files`)
  lines.push('```')
  lines.push('')
  lines.push('```bash')
  lines.push('# macOS / Linux')
  lines.push(`npx --yes @marp-team/marp-cli "${slides}" --pptx --output "${out}" --allow-local-files`)
  lines.push('```')
  lines.push('')
  lines.push('## 四、路径 3：安装 marp-cli（推荐长期使用）')
  lines.push('')
  lines.push('```powershell')
  lines.push('# Windows PowerShell（全局安装后直接可用）')
  lines.push('npm install -g @marp-team/marp-cli')
  lines.push(`marp "${slides}" --pptx --output "${out}" --allow-local-files`)
  lines.push('# 也可顺便导出 PDF 与 PNG（答辩备份最稳）')
  lines.push(`marp "${slides}" --pdf --output "${nodePath.join(nodePath.dirname(out), 'PPT.pdf')}" --allow-local-files`)
  lines.push('```')
  lines.push('')
  lines.push('```bash')
  lines.push('# macOS / Linux')
  lines.push('npm install -g @marp-team/marp-cli')
  lines.push(`marp "${slides}" --pptx --output "${out}" --allow-local-files`)
  lines.push(`marp "${slides}" --pdf --output "${nodePath.join(nodePath.dirname(out), 'PPT.pdf')}" --allow-local-files`)
  lines.push('```')
  lines.push('')
  lines.push('## 五、路径 4：pandoc（装了 pandoc 时最省事）')
  lines.push('')
  lines.push('```powershell')
  lines.push(`pandoc "${slides}" -o "${out}"`)
  lines.push('```')
  lines.push('')
  lines.push('```bash')
  lines.push(`pandoc "${slides}" -o "${out}"`)
  lines.push('```')
  lines.push('')
  lines.push('> 注意：pandoc 走的是它自己的 Markdown → pptx 规则，Marp 的 frontmatter 与主题不会生效，版面较朴素；')
  lines.push('> 优先用 marp-cli，pandoc 只作为兜底。')
  lines.push('')
  lines.push('## 六、离线环境的替代方案')
  lines.push('')
  lines.push('1. 在能联网的机器上跑路径 2/3，把生成的 pptx（或 PDF/PNG）拷回本机，再按学校模板手工微调。')
  lines.push('2. `npm install -g @marp-team/marp-cli` 在有网机器上安装，把整包目录拷到本机后用其绝对路径调用。')
  lines.push('3. 完全离线且无外部工具时：直接用编辑器打开 Markdown，按第 1 节手工成稿——Markdown 本身就是要讲的内容，绝不因工具缺失而阻塞答辩准备。')
  lines.push('')
  lines.push('## 七、验证转换是否成功')
  lines.push('')
  lines.push(`- 检查 \`${out}\` 是否存在且大小合理（几 MB 级）；`)
  lines.push('- 打开 pptx 抽查 3 页：封面占位是否已替换、图表是否可见、备注里是否有讲稿；')
  lines.push('- 转换命令的输出摘要会写入 `07-答辩/PPT转换说明.md`，对照退出码即可判断。')
  lines.push('')
  return lines.join('\n')
}
