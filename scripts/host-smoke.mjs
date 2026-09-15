/**
 * 真实宿主冒烟：把编译产物装进 **真实 DSH 依赖树**，用真实 cordis + dsh-tools 跑一遍装配。
 *
 * 为什么需要它：`tests/composition.test.ts` 用的是假宿主，验证不了三件事——
 * ① 宿主真实的 `ctx.tools.register` 是否接受我们编译出来的 schema；
 * ② `definePaperTool` 是否真的拿到了宿主的 `defineTool`（生产同源）；
 * ③ 真实 `ctx.provide` / `ctx.on` / `ctx.effect` 的生命周期是否按预期工作。
 *
 * 做法：在 `.host-smoke/app/` 里放一份 `lib/`、`skills/`、`package.json`，
 * 并把 `@deepseek-ai` 以 **junction** 指向本机 DSH 安装农场（Windows 下 junction
 * 不需要管理员权限，也不会改动任何已安装内容），然后在那个目录里跑 `run.mjs`。
 *
 * 用法：
 *   node scripts/host-smoke.mjs                 # 生成 .host-smoke/app/run.mjs
 *   node .host-smoke/app/run.mjs                # 执行真实宿主装配（退出码非 0 即失败）
 *   环境变量 DSH_FARM 可显式指定农场目录（其下应有 @deepseek-ai/dsh-tools）。
 *
 * @module dsh-thesis/scripts/host-smoke
 */

import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync, copyFileSync, cpSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const smokeRoot = join(repoRoot, '.host-smoke')
const appRoot = join(smokeRoot, 'app')

/** 从候选位置里找出 DSH 安装农场的 `@deepseek-ai` 目录。 */
function findFarm() {
  const explicit = process.env.DSH_FARM?.trim()
  const candidates = []
  if (explicit !== undefined && explicit !== '') candidates.push(explicit)
  const home = process.env.DSH_HOME?.trim()
  if (home !== undefined && home !== '') candidates.push(join(home, 'profiles', 'node_modules', '@deepseek-ai'))
  const localAppData = process.env.LOCALAPPDATA?.trim()
  if (localAppData !== undefined && localAppData !== '') {
    const npxRoot = join(localAppData, 'npm-cache', '_npx')
    if (existsSync(npxRoot)) {
      for (const entry of readdirSync(npxRoot)) {
        candidates.push(join(npxRoot, entry, 'node_modules', '@deepseek-ai'))
      }
    }
  }
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'dsh-tools', 'lib', 'index.js'))) return candidate
  }
  throw new Error(
    '未找到 DSH 安装农场（其下应有 dsh-tools）。请设置 DSH_FARM 指向包含 @deepseek-ai/* 的目录。\n已尝试：\n  ' +
      candidates.join('\n  '),
  )
}

const farm = findFarm()
console.log(`[host-smoke] 农场：${farm}`)

if (!existsSync(join(repoRoot, 'lib', 'index.js'))) {
  throw new Error('缺少 lib/index.js —— 先运行 npm run build')
}

rmSync(smokeRoot, { recursive: true, force: true })
mkdirSync(join(appRoot, 'node_modules'), { recursive: true })

// 编译产物 + 随包资源 + 清单（复制而非链接：与真实安装形态一致）。
cpSync(join(repoRoot, 'lib'), join(appRoot, 'lib'), { recursive: true })
cpSync(join(repoRoot, 'skills'), join(appRoot, 'skills'), { recursive: true })
copyFileSync(join(repoRoot, 'package.json'), join(appRoot, 'package.json'))

// 宿主的真实依赖树（只读 junction，绝不改动农场）。
symlinkSync(farm, join(appRoot, 'node_modules', '@deepseek-ai'), 'junction')

writeFileSync(join(appRoot, 'run.mjs'), runnerSource(), 'utf8')
console.log('[host-smoke] 已生成 .host-smoke/app/run.mjs')
console.log('[host-smoke] 执行：node .host-smoke/app/run.mjs')

/**
 * 冒烟脚本本体。写在 app 目录里，使它解析到 junction 后的真实宿主包。
 */
function runnerSource() {
  return String.raw`
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as paper from './lib/index.js'

const checks = []
function check(label, condition, detail = '') {
  checks.push({ label, ok: Boolean(condition), detail })
  console.log((condition ? '  ok  ' : ' FAIL ') + label + (detail ? '  [' + detail + ']' : ''))
}

// --- 假 fs / 假 commands：真实宿主里这两者来自 dsh-fs-local 与 dsh-commands，
//     本冒烟只关心工具注册与执行，用最小替身即可（工具内部的 cwd 逻辑返回可读错误）。
const fakeFs = {
  async resolve(path) { return { displayPath: path } },
  async readText(target) { const error = new Error('ENOENT: ' + target.displayPath); error.code = 'ENOENT'; throw error },
  async writeText() { return { version: 1 } },
  async listDir() { return [] },
  async stat() { return undefined },
}
const commandNames = []
const fakeCommands = { register(definition) { commandNames.push(definition.name); return () => {} } }

const ctx = new Context()
ctx.provide('fs', fakeFs)
ctx.provide('commands', fakeCommands)
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRuntime)

const config = { memoryPath: ':memory:', codeWalkthrough: { stateDir: '.paper' } }
await ctx.plugin(paper, config)

// 1) 插件身份与配置 schema
check('插件名 = dsh-thesis', paper.name === 'dsh-thesis', String(paper.name))
check('inject 声明 tools/fs/commands', Array.isArray(paper.inject) && paper.inject.length === 3, JSON.stringify(paper.inject))
check('导出 Config schema', typeof paper.Config === 'function' || typeof paper.Config === 'object')
check('宿主 defineTool 已生效（生产同源）', (await import('./lib/shared/define-tool.js')).usingHostDefineTool === true)

// 2) 真实注册表接受了我们的工具定义
const schemas = ctx.tools.schemas()
const names = schemas.map(schema => schema.name).sort()
const expected = [
  'thesis_ingest', 'thesis_intake', 'thesis_init', 'thesis_progress', 'thesis_decide',
  'thesis_lit_search', 'thesis_lit_save', 'thesis_lit_note',
  'thesis_review', 'thesis_check', 'thesis_build', 'thesis_stylecheck',
  'thesis_originality', 'thesis_defense', 'thesis_slides',
  'defense_code_status', 'defense_code_next', 'defense_code_update',
  'fact_search', 'fact_remember', 'fact_context',
].sort()
check('注册工具数 = 21', names.length === 21, 'got ' + names.length + ': ' + names.join(','))
const missing = expected.filter(name => !names.includes(name))
check('工具名集合与契约一致', missing.length === 0, missing.length ? '缺少 ' + missing.join(',') : 'ok')
const extra = names.filter(name => !expected.includes(name))
check('没有多余工具', extra.length === 0, extra.join(','))

// 3) 参数 schema 真的落到了宿主形态（要求根级 object + required 数组）
const progressSchema = schemas.find(schema => schema.name === 'thesis_progress')
const parameters = progressSchema?.parameters ?? {}
check('thesis_progress 参数被编译为 JSON Schema', parameters.type === 'object' && Array.isArray(parameters.required), JSON.stringify(parameters.required))
check('thesis_progress 必填 action', Array.isArray(parameters.required) && parameters.required.includes('action'))
check('属性上不残留 required:true', parameters.properties?.action?.required === undefined)

// 4) 命令注册（假注册表收集名字）
const expectedCommands = ['thesis-status', 'thesis-decide', 'thesis-lit', 'thesis-check', 'thesis-build',
  'thesis-ingest', 'thesis-intake', 'thesis-originality', 'thesis-defense']
const missingCommands = expectedCommands.filter(name => !commandNames.includes(name))
check('命令名集合与契约一致（9 个）', missingCommands.length === 0 && commandNames.length === expectedCommands.length,
  missingCommands.length ? '缺少 ' + missingCommands.join(',') : 'got ' + commandNames.join(','))

// 5) 服务注册
check('ctx.memory 已注册', ctx.get('memory') !== undefined)
check('ctx.paperCodeWalkthrough 已注册', ctx.get('paperCodeWalkthrough') !== undefined)

// 6) 真实执行一个工具（跨会话事实：不依赖会话 cwd）
const signal = new AbortController().signal
const remember = await ctx.tools.execute({
  signal, callId: 'smoke-remember', name: 'fact_remember',
  arguments: { key: 'smoke.check.value', value: 'life-is-short' },
})
check('fact_remember 执行成功', remember.isError === false, JSON.stringify(remember.content ?? remember).slice(0, 200))

const search = await ctx.tools.execute({
  signal, callId: 'smoke-search', name: 'fact_search',
  arguments: { query: 'life-is-short' },
})
const rendered = (search.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('')
check('fact_search 能读回刚写入的值', rendered.includes('smoke.check.value = life-is-short'), rendered.slice(0, 200))

// 7) 参数校验由宿主把关：缺必填参数必须报错而不是静默执行
const bad = await ctx.tools.execute({
  signal, callId: 'smoke-bad', name: 'thesis_progress', arguments: {},
})
check('缺必填参数被宿主拒绝（INVALID_ARGS）', bad.isError === true, JSON.stringify(bad.content ?? bad).slice(0, 200))

// 7b) 空 query 的事实检索必须被我们自己的逻辑拒绝（语义边界，宿主 schema 管不到）
const emptyQuery = await ctx.tools.execute({
  signal, callId: 'smoke-empty', name: 'fact_search', arguments: { query: '' },
})
check('空 query 的 fact_search 被拒绝（不返回整张表）', emptyQuery.isError === true,
  JSON.stringify(emptyQuery.content ?? emptyQuery).slice(0, 160))

// 7c) 闸门注入：走**真实 cordis 的 waterfall 派发**，验证「写作意图 → 注入追问指令」。
// 这是闸门唯一真正重要的行为：学生说「帮我写第三章」时，模型必须先被要求去追问。
const userMessage = (text) => ({
  id: 'smoke-msg-' + Math.random().toString(36).slice(2),
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
})
const enterNext = async () => ({ kind: 'enter', messages: [] })

const gateMessages = await ctx.waterfall('agent/pre-step', {
  agent: undefined, messages: [userMessage('帮我写第三章')], turn: 1, step: 1, signal,
}, enterNext)
const injected = (gateMessages?.messages ?? []).filter(m => m.source?.plugin === 'dsh-thesis')
check('写作意图触发闸门并注入插件消息', injected.length === 1, 'injected=' + injected.length)
check('注入消息来自 dsh-thesis 且带 sections',
  injected[0]?.source?.plugin === 'dsh-thesis' && Array.isArray(injected[0]?.source?.sections),
  JSON.stringify(injected[0]?.source?.sections?.[0]?.name ?? null))
const injectedText = (injected[0]?.content ?? []).map(b => b.text ?? '').join('')
check('注入指令要求先追问（含 thesis_intake）', /thesis_intake/.test(injectedText) && /追问|问清/.test(injectedText),
  injectedText.slice(0, 80))

const bypassed = await ctx.waterfall('agent/pre-step', {
  agent: undefined, messages: [userMessage('帮我写第三章，直接写')], turn: 1, step: 1, signal,
}, enterNext)
check('用户说「直接写」时闸门放行（有终止条件）',
  (bypassed?.messages ?? []).filter(m => m.source?.plugin === 'dsh-thesis').length === 0)

const unrelated = await ctx.waterfall('agent/pre-step', {
  agent: undefined, messages: [userMessage('帮我看看这个报错是什么意思')], turn: 1, step: 1, signal,
}, enterNext)
check('无关消息不注入（闸门安静）',
  (unrelated?.messages ?? []).filter(m => m.source?.plugin === 'dsh-thesis').length === 0)

// 7d) 意图规格闸门：工作区不可读时**不得**注入「先立规格」指令。
// 注意要按 message id 对比下游基线——写作意图闸门对同一句话本来就会注入一条，
// 我们要确认的是「有没有**第二条**（规格闸门那条）」。这正好防止把两个闸门
// 混淆成一个（它们共用同一个 plugin 来源标记）。
const specGate = await ctx.waterfall('agent/pre-step', {
  agent: { session: { header: { cwd: process.cwd() } } },
  messages: [userMessage('帮我写第三章')], turn: 1, step: 1, signal,
}, enterNext)
const specInjected = (specGate?.messages ?? []).filter(m =>
  m.source?.plugin === 'dsh-thesis' && (m.source?.sections ?? []).some(s => s.name === '意图规格闸门'))
check('工作区不可读时意图规格闸门不介入（宁漏勿错）', specInjected.length === 0,
  'intakeInjected=' + specInjected.length)

// 8) 卸载：plugin fiber 销毁后工具应被注销（disposer 生效）
await ctx.fiber?.dispose?.()
let afterDispose = -1
try { afterDispose = ctx.tools.schemas().length } catch { afterDispose = 0 }
check('卸载后工具已注销（fiber 释放）', afterDispose === 0, 'got ' + afterDispose)

const failed = checks.filter(item => !item.ok)
console.log('\n[host-smoke] ' + (checks.length - failed.length) + '/' + checks.length + ' 通过')
if (failed.length > 0) process.exitCode = 1
`
}
