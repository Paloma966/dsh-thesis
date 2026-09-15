/**
 * 把本插件装进一个 DSH profile —— **不需要 pnpm** 的兜底安装路径。
 *
 * 背景：`dsh plugin --profile <name> add <spec>` 会把安装转发给 pnpm；本机（以及不少
 * 只装了 Node 的机器）没有 pnpm，标准路径直接失败。DSH 的模块解析在 profile 的
 * `node_modules` 里找不到时会回退到安装农场，因此**在 profile 的 node_modules 下建一个
 * 指向本仓库的 junction（Windows 目录联接，无需管理员权限）**，再往 profile 的
 * `cordis.patch.yml` 里加一行插件行，就能完成等价的挂载。
 *
 * 本脚本只做两件事，且都可回退：
 *   1. 建/更新 `<profile>/node_modules/dsh-thesis` 的目录联接（若目标已存在且不是联接，
 *      则拒绝覆盖并提示）；
 *   2. 打印需要追加到 `<profile>/cordis.patch.yml` 的补丁片段（**不自动改你的 profile
 *      配置**——那是你的文件，由你复制粘贴，避免脚本擅自改动）。
 *
 * 用法：
 *   node scripts/install-into-profile.mjs --profile web          # 建联接 + 打印补丁片段
 *   node scripts/install-into-profile.mjs --profile web --remove # 移除联接
 *
 * 安装后重启 dsh 生效。标准路径（需要 pnpm）：
 *   dsh plugin --profile web add <本仓库路径>
 *
 * @module dsh-thesis/scripts/install-into-profile
 */

import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const args = { profile: undefined, remove: false }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--profile') args.profile = argv[++i]
    else if (token === '--remove') args.remove = true
    else if (token === '--help' || token === '-h') args.help = true
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
if (args.help === true || args.profile === undefined) {
  console.log('用法：node scripts/install-into-profile.mjs --profile <name> [--remove]')
  process.exit(args.help === true ? 0 : 1)
}

const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
const profileDir = join(dshHome, 'profiles', args.profile)
if (!existsSync(profileDir)) {
  console.error(`找不到 profile 目录：${profileDir}`)
  console.error('先用 dsh 创建/启动一次该 profile，或用 --profile 指定已存在的 profile 名。')
  process.exit(1)
}

const linkPath = join(profileDir, 'node_modules', 'dsh-thesis')

if (args.remove === true) {
  if (existsSync(linkPath)) {
    rmSync(linkPath, { recursive: true, force: true })
    console.log(`已移除：${linkPath}`)
  } else {
    console.log(`未安装（不存在）：${linkPath}`)
  }
  process.exit(0)
}

const packageJsonPath = join(repoRoot, 'package.json')
if (!existsSync(packageJsonPath)) {
  console.error(`这不是一个插件仓库（缺 package.json）：${repoRoot}`)
  process.exit(1)
}
if (!existsSync(join(repoRoot, 'lib', 'index.js'))) {
  console.error('缺少编译产物 lib/index.js —— 请先运行：npm install && npm run build')
  process.exit(1)
}

mkdirSync(join(profileDir, 'node_modules'), { recursive: true })

if (existsSync(linkPath)) {
  const stat = lstatSync(linkPath)
  const isLink = stat.isSymbolicLink()
  let target
  try { target = isLink ? readlinkSync(linkPath) : undefined } catch { target = undefined }
  if (!isLink) {
    console.error(`已存在同名目录且不是联接，拒绝覆盖：${linkPath}`)
    console.error('若确认要替换，请先手动删除它。')
    process.exit(1)
  }
  rmSync(linkPath, { recursive: true, force: true })
  console.log(`已移除旧联接（原指向 ${String(target)}）`)
}

symlinkSync(repoRoot, linkPath, 'junction')
console.log(`已建立联接：${linkPath}  ->  ${repoRoot}`)

console.log('\n下一步（两步，都不可省）：')
console.log(`1) 在 ${join(profileDir, 'cordis.patch.yml')} 里追加下面这段（文件是 YAML 数组，追加到末尾即可）：\n`)
console.log('   - insert:')
console.log('       - id: paper')
console.log('         name: dsh-thesis')
console.log('\n   若要自定义配置，写成：\n')
console.log('   - insert:')
console.log('       - id: paper')
console.log('         name: dsh-thesis')
console.log('         config:')
console.log("           memoryPath: C:\\\\Users\\\\you\\\\.dsh\\\\dsh-thesis-memory.db")
console.log('           ppt: { engine: auto }')
console.log('\n2) 重启 dsh（插件行在下次启动时生效）。')
console.log('\n验证（重启后任选其一）：')
console.log('   · 敲 /thesis-status —— 能看到台账状态就说明工具与命令面都活了；')
console.log('   · 对着 AI 说「帮我写第三章」——应触发**写作意图闸门**，要求先用 thesis_intake 追问；')
console.log('   · 问「你现在有哪些论文相关工具」——应报出 thesis_* / fact_* / defense_code_* 三个命名空间。')
console.log('\n卸载：node scripts/install-into-profile.mjs --profile ' + args.profile + ' --remove（并删掉上面那段 YAML）。')
