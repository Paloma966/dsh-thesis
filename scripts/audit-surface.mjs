/**
 * 对外表面审计：把「工具 / 命令 / 技能的名字与元数据」变成可执行断言。
 *
 * 用法：node scripts/audit-surface.mjs        （退出码非 0 即失败）
 *
 * 检查四件事：
 * 1. **工具契约**：源码里注册的工具名必须**恰好**等于 `EXPECTED_TOOLS`，
 *    且每个名字落在 `thesis_` / `fact_` / `defense_code_` 三个命名空间之一。
 *    多一个或少一个都失败——工具名是对外契约，学生按名字调用。
 * 2. **命令契约**：命令名必须恰好等于 `EXPECTED_COMMANDS`，且符合 DSH 的命名约束。
 * 3. **技能一致性**：每个 `skills/<dir>/SKILL.md` 的 frontmatter `name` 必须等于目录名
 *    （DSH 按目录名发现技能，名字漂移会让技能静默失效）。
 * 4. **宿主解析的文件不得带 BOM**：只针对各技能的 `SKILL.md` 与仓库根的两个配置文件。
 *    带 BOM 的 `SKILL.md` 会被 DSH 的 frontmatter 解析**静默忽略**（首行判定为
 *    `"\uFEFF---"` 而非 `"---"`，函数直接返回 undefined），这是最难发现的一类故障：
 *    文件明明在，技能却不存在。`package.json` / `cordis.patch.yml` 由宿主与 npm 解析，
 *    带 BOM 时同样直接解析失败。
 *    普通 `.md` 文档**不在**此列——GitHub 与编辑器都会吞掉 BOM，把它们算作硬失败
 *    就是口径不诚实，宁可少管也不要吓唬人。
 *
 * **本脚本不再负责「零前身残留」**：那批词汇禁令是重构过渡期的脚手架，
 * 用来防止旧概念在改写过程中渗回来。脚手架已完成使命，随之删除——
 * 当前契约由上面四项长期守住。
 *
 * @module dsh-thesis/scripts/audit-surface
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 工具契约（名字即契约，改动必须同步这里与 tests/composition.test.ts）。 */
const EXPECTED_TOOLS = [
  'thesis_ingest', 'thesis_intake', 'thesis_init', 'thesis_progress', 'thesis_decide',
  'thesis_lit_search', 'thesis_lit_save', 'thesis_lit_note',
  'thesis_review', 'thesis_check', 'thesis_build', 'thesis_stylecheck',
  'thesis_originality', 'thesis_defense', 'thesis_slides',
  'defense_code_status', 'defense_code_next', 'defense_code_update',
  'fact_search', 'fact_remember', 'fact_context',
]

/** 命令契约。 */
const EXPECTED_COMMANDS = [
  'thesis-status', 'thesis-decide', 'thesis-lit', 'thesis-check', 'thesis-build',
  'thesis-ingest', 'thesis-intake', 'thesis-originality', 'thesis-defense',
]

const NAMESPACE_PREFIXES = ['thesis_', 'fact_', 'defense_code_']

/** 必须无 BOM 的根级配置——它们被宿主与 npm 直接按字节解析。 */
const BOM_CHECKED_ROOT_FILES = ['package.json', 'cordis.patch.yml']

const problems = []
const notes = []
function fail(message) {
  problems.push(message)
}

/** UTF-8 BOM 的三个字节。 */
function hasBom(raw) {
  return raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf
}

// ---- 1. 工具契约：源码里注册的名字必须恰好等于契约 ----
const registeredTools = []
const walkSource = (relDir) => {
  const abs = join(repoRoot, relDir)
  if (!existsSync(abs)) return
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const rel = `${relDir}/${entry.name}`
    if (entry.isDirectory()) walkSource(rel)
    else if (/\.ts$/.test(entry.name)) {
      const text = readFileSync(join(repoRoot, rel), 'utf8')
      for (const m of text.matchAll(/^\s*name:\s*'([a-z][a-z0-9_]*)',\s*$/gm)) registeredTools.push({ name: m[1], file: rel })
    }
  }
}
walkSource('src')
const registeredNames = registeredTools.map(t => t.name).filter(name => NAMESPACE_PREFIXES.some(p => name.startsWith(p)))
const strayRegistered = registeredTools.filter(t => !NAMESPACE_PREFIXES.some(p => t.name.startsWith(p)))
for (const stray of strayRegistered) {
  fail(`${stray.file} 注册了不在三个命名空间内的工具名「${stray.name}」（须为 thesis_ / fact_ / defense_code_ 前缀）`)
}
const missingTools = EXPECTED_TOOLS.filter(name => !registeredNames.includes(name))
const extraTools = registeredNames.filter(name => !EXPECTED_TOOLS.includes(name))
if (missingTools.length > 0) fail(`契约里的工具未在源码中注册：${missingTools.join(', ')}`)
if (extraTools.length > 0) fail(`源码注册了契约外的工具：${extraTools.join(', ')}`)
notes.push(`工具：注册 ${registeredNames.length} 个，契约 ${EXPECTED_TOOLS.length} 个`)

// ---- 2. 命令契约 ----
const registeredCommands = []
const walkCommands = (relDir) => {
  for (const entry of readdirSync(join(repoRoot, relDir), { withFileTypes: true })) {
    const rel = `${relDir}/${entry.name}`
    if (entry.isDirectory()) walkCommands(rel)
    else if (/\.ts$/.test(entry.name)) {
      const text = readFileSync(join(repoRoot, rel), 'utf8')
      for (const m of text.matchAll(/^\s*name:\s*'([a-z][a-z0-9_-]*)',\s*$/gm)) {
        if (m[1].includes('-')) registeredCommands.push(m[1])
      }
    }
  }
}
walkCommands('src')
const missingCommands = EXPECTED_COMMANDS.filter(name => !registeredCommands.includes(name))
const extraCommands = registeredCommands.filter(name => !EXPECTED_COMMANDS.includes(name))
if (missingCommands.length > 0) fail(`契约里的命令未注册：${missingCommands.join(', ')}`)
if (extraCommands.length > 0) fail(`注册了契约外的命令：${extraCommands.join(', ')}`)
for (const name of registeredCommands) {
  if (!/^[a-z][a-z0-9_-]*$/.test(name)) fail(`命令名 ${name} 不符合 DSH 的 /^[a-z][a-z0-9_-]*$/ 约束`)
}
notes.push(`命令：注册 ${registeredCommands.length} 个，契约 ${EXPECTED_COMMANDS.length} 个`)

// ---- 3. 技能：frontmatter name 必须等于目录名 ----
const skillsRoot = join(repoRoot, 'skills')
const skillDirs = readdirSync(skillsRoot, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort()
for (const dir of skillDirs) {
  const skillFile = join(skillsRoot, dir, 'SKILL.md')
  if (!existsSync(skillFile)) {
    fail(`skills/${dir} 缺少 SKILL.md`)
    continue
  }
  const raw = readFileSync(skillFile)
  // 带 BOM 时首行是 `\uFEFF---`，DSH 的 parseFrontmatter 返回 undefined → **整个技能被静默忽略**
  // （只有一条 warn 日志）。文件明明在、技能却不存在，是最难排查的一类故障。
  if (hasBom(raw)) {
    fail(`skills/${dir}/SKILL.md 带 UTF-8 BOM —— DSH 会静默忽略整个技能（首行判定为 "\\uFEFF---"）`)
  }
  const text = raw.toString('utf8')
  const frontmatter = text.replace(/\r\n/g, '\n')
  const m = /^---\n([\s\S]*?)\n---/.exec(frontmatter)
  if (m === null) {
    fail(`skills/${dir}/SKILL.md 缺少 frontmatter（若文件带 BOM，首行是 "\\uFEFF---"，解析会直接返回 undefined）`)
    continue
  }
  const nameMatch = /^name:\s*(\S+)\s*$/m.exec(m[1])
  const descMatch = /^description:\s*\S/m.exec(m[1])
  if (nameMatch === null) fail(`skills/${dir}/SKILL.md 的 frontmatter 缺 name`)
  else if (nameMatch[1] !== dir) fail(`skills/${dir} 的 frontmatter name 是「${nameMatch[1]}」，必须等于目录名`)
  if (descMatch === null) fail(`skills/${dir}/SKILL.md 的 frontmatter 缺 description`)
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(nameMatch?.[1] ?? '')) fail(`skills/${dir} 的技能名不符合 kebab-case`)
}
notes.push(`技能：${skillDirs.length} 个（${skillDirs.join(', ')}）`)

// ---- 4. 根级配置不得带 BOM ----
for (const rel of BOM_CHECKED_ROOT_FILES) {
  const abs = join(repoRoot, rel)
  if (!existsSync(abs)) {
    fail(`缺少 ${rel}`)
    continue
  }
  if (hasBom(readFileSync(abs))) {
    fail(`${rel} 带 UTF-8 BOM —— 宿主与 npm 按字节解析会直接失败`)
  }
}
notes.push(`BOM 检查：${skillDirs.length} 个 SKILL.md + ${BOM_CHECKED_ROOT_FILES.join(' / ')}`)

// ---- 报告 ----
console.log('[audit-surface] dsh-thesis 对外表面审计')
for (const note of notes) console.log(`  · ${note}`)
if (problems.length === 0) {
  console.log('\n结果：工具/命令/技能契约一致，对外元数据无 BOM。')
  process.exitCode = 0
} else {
  console.log(`\n结果：发现 ${problems.length} 个不一致：`)
  for (const problem of problems) console.log(`  ✗ ${problem}`)
  process.exitCode = 1
}
