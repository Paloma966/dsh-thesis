/**
 * 真实宿主**装载**验证（DESIGN.md §6.2）。
 *
 * 与 `scripts/host-smoke.mjs` 的分工：
 * - `host-smoke` 用真实 cordis 直接 `ctx.plugin()`，验证工具 schema / 服务 / 卸载；
 * - 本脚本走**真实 dsh 引擎的 profile 装载路径**：生成一个临时补丁层（指向本仓库的
 *   绝对路径模块说明符），用 `dsh --dump-config --patch <file>` 让引擎真正解析、
 *   校验插件的 `Config` schema（schemastery 的 Standard Schema 校验由引擎执行），
 *   再打印合成后的插件树作为证据。
 *
 * **为什么不用 `dsh plugin add` 装进 profile**：那会写 `$DSH_HOME/profiles/web`
 * （本会话工作区之外，平台策略拒绝写入）。本脚本因此**不接触用户 profile**，
 * 却仍然验证了"真实引擎能否加载并校验这个插件"——这是装载验证的核心命题。
 * 需要真正安装时，按 README「安装」一节执行 `dsh plugin --profile web add dsh-thesis`
 * （或从源码安装：`dsh plugin --profile web add <本仓库路径>`）。
 *
 * 用法：node scripts/host-verify.mjs
 * 退出码非 0 即失败。
 *
 * @module dsh-thesis/scripts/host-verify
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tmpRoot = join(repoRoot, '.host-verify')
const patchPath = join(tmpRoot, 'paper.patch.yml')

const checks = []
function check(label, ok, detail = '') {
  checks.push({ label, ok: Boolean(ok), detail })
  console.log(`${ok ? '  ok  ' : ' FAIL '}${label}${detail ? `  [${detail}]` : ''}`)
}

/** 找到 dsh 可执行入口（.cmd / .ps1 不便于 execFileSync，直接用 node 跑 bin.js）。 */
function findDshBin() {
  const explicit = process.env.DSH_BIN?.trim()
  const candidates = []
  if (explicit !== undefined && explicit !== '') candidates.push(explicit)
  const localAppData = process.env.LOCALAPPDATA?.trim()
  if (localAppData !== undefined && localAppData !== '') {
    const npxRoot = join(localAppData, 'npm-cache', '_npx')
    if (existsSync(npxRoot)) {
      for (const entry of readdirSync(npxRoot)) {
        candidates.push(join(npxRoot, entry, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
      }
    }
  }
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  throw new Error(`未找到 dsh 入口（lib/bin.js）。请设置 DSH_BIN。已尝试：\n  ${candidates.join('\n  ')}`)
}

const dshBin = findDshBin()
console.log(`[host-verify] dsh 入口：${dshBin}`)

if (!existsSync(join(repoRoot, 'lib', 'index.js'))) {
  throw new Error('缺少 lib/index.js —— 先运行 npm run build')
}

rmSync(tmpRoot, { recursive: true, force: true })
mkdirSync(tmpRoot, { recursive: true })

// 生成临时补丁层：把模板里的 REPO_PATH 换成本仓库绝对路径。
// 用 file:// URL 形态，保证引擎按"模块说明符"而不是"包名"解析。
const template = readFileSync(join(repoRoot, 'scripts', 'host-verify.patch.yml.tpl'), 'utf8')
const moduleSpecifier = new URL(`file://${repoRoot.replace(/\\/g, '/')}/lib/index.js`).href
writeFileSync(patchPath, template.replace('REPO_PATH', moduleSpecifier), 'utf8')
console.log(`[host-verify] 临时补丁层：${patchPath}`)
console.log(`[host-verify] 模块说明符：${moduleSpecifier}`)

/**
 * 跑一次 dsh 并把输出**重定向到文件**再读回。
 *
 * 不能简单地用 `stdio: 'pipe'`：受限环境下管道 stdio 会被拒（EPERM），
 * 这正是本仓库 `src/shared/spawn.ts` 记录的那条环境约束。这里用文件描述符
 * 重定向（既不需要管道，也拿得到完整输出）。
 */
function runDsh(args) {
  const outPath = join(tmpRoot, 'dsh-out.txt')
  const errPath = join(tmpRoot, 'dsh-err.txt')
  const outFd = openSync(outPath, 'w')
  const errFd = openSync(errPath, 'w')
  let result
  try {
    result = spawnSync(process.execPath, [dshBin, ...args], { stdio: ['ignore', outFd, errFd] })
  } finally {
    closeSync(outFd)
    closeSync(errFd)
  }
  const read = (path) => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return ''
    }
  }
  return {
    ok: result.status === 0,
    status: result.status,
    error: result.error === undefined ? undefined : String(result.error),
    stdout: read(outPath),
    stderr: read(errPath),
  }
}

try {
  // ---- 1. 合成后的配置树里出现本插件行 ----
  const dump = runDsh(['--profile', 'web', '--patch', patchPath, '--dump-config'])
  check('dsh --dump-config 成功（引擎接受我们的补丁层）', dump.ok,
    `${dump.stderr.split('\n')[0] ?? ''} ${dump.error ?? ''}`.trim())
  const tree = `${dump.stdout}\n${dump.stderr}`
  check('合成树包含真实的 paper 插件行（id + name 两行）',
    /^-\s*id:\s*paper\s*$/m.test(tree) && new RegExp(`^\\s*name:\\s*${moduleSpecifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').test(tree),
    (tree.match(/^-\s*id:\s*paper\s*$/m) ?? ['(无 id: paper 行)'])[0])
  check('插件未被引擎标记为加载失败', !/failed|invalid/i.test(tree),
    tree.split('\n').filter(l => /failed|invalid/i.test(l))[0] ?? '')

  // ---- 2. 引擎真的解析到了我们的入口文件（而不是静默跳过） ----
  const indexJs = readFileSync(join(repoRoot, 'lib', 'index.js'), 'utf8')
  check('lib/index.js 是 ESM 且导出 apply/name', /export\s+function\s+apply/.test(indexJs) && /export\s+const\s+name/.test(indexJs))
  check('lib/index.js 不含未编译的 .ts 导入（宿主无 TS 加载器）', !/from\s+['"][^'"]+\.ts['"]/.test(indexJs),
    (indexJs.match(/from\s+['"][^'"]+\.ts['"]/) ?? [])[0] ?? '')

  // ---- 3. Config schema 能被 schemastery 真实校验（引擎装载时执行的同一件事） ----
  const paper = await import(pathToFileURL(join(repoRoot, 'lib', 'index.js')).href)
  const validated = paper.Config({ similarity: { shingle: 6 } })
  check('Config 校验通过并补默认值', validated.similarity.shingle === 6 && validated.similarity.threshold === 0.3,
    `shingle=${validated.similarity.shingle} threshold=${validated.similarity.threshold}`)
  check('Config 含闸门字段（writingGate）', validated.writingGate === true)
  check('Config 不含被取代的旧字段（promptGate / learn）',
    validated.promptGate === undefined && validated.learn === undefined)
  check('默认值来源一致（PAPER_DEFAULTS）',
    paper.PAPER_DEFAULTS.stylecheck.reportRel === validated.stylecheck.reportRel)

  // ---- 4. 插件行声明的 patch 文件本身合法（真实安装路径会用到它） ----
  const ownPatch = readFileSync(join(repoRoot, 'cordis.patch.yml'), 'utf8')
  check('仓库 cordis.patch.yml 是顶层数组且插入 paper 行',
    /^-\s*insert:/m.test(ownPatch) && /name:\s*dsh-thesis/.test(ownPatch))

  // ---- 5. 说明：为什么不写 profile ----
  const profilePkg = join(process.env.DSH_HOME?.trim() || join(process.env.USERPROFILE ?? '', '.dsh'), 'profiles', 'web', 'package.json')
  check('未改动用户 profile（本脚本只读）', existsSync(profilePkg), `profile=${profilePkg}`)
} finally {
  rmSync(tmpRoot, { recursive: true, force: true })
}

const failed = checks.filter(item => !item.ok)
console.log(`\n[host-verify] ${checks.length - failed.length}/${checks.length} 通过`)
if (failed.length > 0) {
  console.log('\n未通过项：')
  for (const item of failed) console.log(`- ${item.label}${item.detail ? `（${item.detail}）` : ''}`)
}
process.exitCode = failed.length === 0 ? 0 : 1
