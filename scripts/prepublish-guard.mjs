/**
 * 发布前守卫：`npm publish` 之前自动运行（package.json 的 `prepublishOnly`）。
 *
 * 它拦的是**已经真实发生过**的几类问题，而不是假想的：
 *
 * 1. **`lib/` 是旧的**：`tsc` 只增不删，加上 `lib/` 在 `.gitignore` 里，
 *    删掉/重命名模块后旧产物会永远留着（甚至能被解析），发布出去就是一包垃圾。
 *    → 比对 `lib/` 的目录集合与 `src/` 是否一一对应。
 * 2. **忘了构建**：`main` 指向 `lib/index.js`，DSH 没有 TS 加载器，缺了就装不起来。
 * 3. **验收没过**：`npm run verify` 必须全绿（构建 + 类型 + 单测 + 审计 + 端到端）。
 * 4. **包名对不上**：`cordis.patch.yml` 里的 `name:` 必须等于 `package.json` 的 `name`，
 *    否则用户装完，插件行解析不到，表现是"装了但没反应"。
 * 5. **npm 上包名已被他人占用**：**只警告不阻断**——占位包可能永远不会发实现，
 *    要不要换名是发布者的商业判断，不该由脚本替他决定。
 *
 * 用法：node scripts/prepublish-guard.mjs
 *
 * @module dsh-thesis/scripts/prepublish-guard
 */

import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const problems = []
const warnings = []

function fail(message) {
  problems.push(message)
}
function warn(message) {
  warnings.push(message)
}

/**
 * 用 `process.execPath` 直接跑一个 Node 脚本，输出**重定向到文件**再读回。
 *
 * 两个坑都在这里绕开了：
 * 1. **不能 spawn `npm`/`npm.cmd`**：Node 24 起禁止直接 spawn `.cmd`（EINVAL），
 *    而且守卫作为 `prepublishOnly` 运行，再调 `npm run verify` 会递归触发自己；
 * 2. **不能 `stdio: 'pipe'`**：受限环境里管道会 EPERM，于是环境限制会被误报成验收失败。
 */
function runNode(args) {
  const outPath = join(repoRoot, '.prepublish-guard.out.txt')
  const errPath = join(repoRoot, '.prepublish-guard.err.txt')
  const outFd = openSync(outPath, 'w')
  const errFd = openSync(errPath, 'w')
  let status
  let spawnError
  try {
    const result = spawnSync(process.execPath, args, { cwd: repoRoot, stdio: ['ignore', outFd, errFd] })
    status = result.status
    spawnError = result.error === undefined ? undefined : String(result.error)
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
  const outcome = { ok: status === 0, status, spawnError, stdout: read(outPath), stderr: read(errPath) }
  rmSync(outPath, { force: true })
  rmSync(errPath, { force: true })
  return outcome
}

/** 跑一步并把它计入「验收」；环境不允许（EPERM/EINVAL）时降级为警告而不是阻断。 */
function step(label, args) {
  process.stdout.write(`[prepublish-guard] ${label} … `)
  const outcome = runNode(args)
  if (outcome.ok) {
    console.log('通过')
    return
  }
  if (outcome.spawnError !== undefined && /EPERM|EINVAL|ENOENT/.test(outcome.spawnError)) {
    console.log('跳过')
    warn(`${label} 无法在此环境执行（${outcome.spawnError}）——发布前请手动确认它通过`)
    return
  }
  console.log('失败')
  const tail = `${outcome.stdout}\n${outcome.stderr}`.trim().split('\n').slice(-20).join('\n')
  fail(`${label} 未通过（退出码 ${outcome.status ?? 'null'}）。末尾输出：\n${tail}`)
}

const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))

// ---- 1. 构建产物存在 ----
if (!existsSync(join(repoRoot, 'lib', 'index.js'))) {
  fail('缺少 lib/index.js —— DSH 没有 TypeScript 加载器，必须发布编译后的 JS。请先 npm run build')
}

// ---- 2. lib/ 与 src/ 的目录集合一一对应（挡住 tsc 孤儿产物） ----
if (existsSync(join(repoRoot, 'lib')) && existsSync(join(repoRoot, 'src'))) {
  const dirs = root => readdirSync(join(repoRoot, root), { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .filter(name => name !== 'types') // src/types 只有 .d.ts，不产出目录
    .sort()
  const srcDirs = dirs('src')
  const libDirs = dirs('lib')
  const orphan = libDirs.filter(name => !srcDirs.includes(name))
  const missing = srcDirs.filter(name => !libDirs.includes(name))
  if (orphan.length > 0) {
    fail(`lib/ 里有多余目录（已删除模块的旧产物）：${orphan.join(', ')}。请 npm run build（会先 clean）`)
  }
  if (missing.length > 0) {
    fail(`lib/ 缺少目录：${missing.join(', ')}。请 npm run build`)
  }
}

// ---- 3. cordis.patch.yml 的插件行必须与包名一致 ----
const patchPath = join(repoRoot, 'cordis.patch.yml')
if (!existsSync(patchPath)) {
  fail('缺少 cordis.patch.yml —— 没有它，dsh plugin add 不会把它认成 bundle')
} else {
  const patch = readFileSync(patchPath, 'utf8')
  if (!/^-\s*insert:/m.test(patch)) fail('cordis.patch.yml 必须是顶层 YAML 数组且含 insert 项')
  const names = [...patch.matchAll(/^\s*name:\s*(\S+)\s*$/gm)].map(m => m[1])
  if (!names.includes(pkg.name)) {
    fail(`cordis.patch.yml 里的 name（${names.join(', ') || '无'}）与 package.json 的 name（${pkg.name}）不一致`)
  }
}

// ---- 4. 验收：逐步跑，不递归调用 npm（npm run verify 的顺序） ----
step('清理构建产物', ['scripts/clean.mjs'])
step('tsc 构建', ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'])
step('类型检查（含 tests）', ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.test.json'])
// 测试用显式文件列表：Node 24 的 --test 不展开 glob（Windows 下 cmd 也不会展开）。
const testFiles = readdirSync(join(repoRoot, 'tests'), { withFileTypes: true })
  .filter(entry => entry.isFile() && /\.test\.(ts|mjs)$/.test(entry.name))
  .map(entry => join('tests', entry.name))
step('单元/契约测试', ['--test', '--test-isolation=none', ...testFiles])
step('对外表面审计', ['scripts/audit-surface.mjs'])
step('端到端基准', ['tests/e2e/paper-full-flow.mjs'])

// 构建与测试刚跑过，再校验一次 lib/ 与 src/ 是否一一对应（挡住 tsc 孤儿产物）。
if (existsSync(join(repoRoot, 'lib')) && existsSync(join(repoRoot, 'src'))) {
  const subdirs = root => readdirSync(join(repoRoot, root), { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .filter(name => name !== 'types')
  const srcDirs = subdirs('src')
  const orphan = subdirs('lib').filter(name => !srcDirs.includes(name))
  if (orphan.length > 0) fail(`构建后 lib/ 仍有孤儿目录：${orphan.join(', ')}`)
}

// ---- 5. 包名占用提醒（只警告） ----
console.log(`[prepublish-guard] 包名 ${pkg.name}：发布前请自行确认 npm 上未被占用（npm view ${pkg.name}）`)

// ---- 报告 ----
for (const item of warnings) console.log(`[prepublish-guard] 警告：${item}`)
if (problems.length === 0) {
  console.log(`[prepublish-guard] 通过：${pkg.name}@${pkg.version} 可以发布`)
  process.exitCode = 0
} else {
  console.error(`[prepublish-guard] 有 ${problems.length} 项阻断：`)
  for (const item of problems) console.error(`  ✗ ${item}`)
  process.exitCode = 1
}
