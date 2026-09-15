/**
 * thesis_init：一键生成论文工作区（DESIGN.md §5 目录结构 + 技能包 + git 初始化）。
 *
 * 校验规则：
 * - root 必须是绝对路径；
 * - 目标目录存在且非空时拒绝（除非 force），绝不覆盖已有文件。
 */

import * as nodePath from 'node:path'
import { readFile, readdir } from 'node:fs/promises'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { describeFailure, spawnCommand } from '../../shared/spawn.ts'
import { buildLayout } from '../lib/layout.ts'

export interface InitArgs {
  root: string
  title?: string
  git?: boolean
  force?: boolean
}

export interface InitOutcome {
  readonly root: string
  readonly files: number
  readonly skills: number
  readonly git: 'ok' | 'skipped' | 'failed'
  readonly gitDetail?: string
}

async function dirEntries(fs: FileSystem, dir: string): Promise<string[] | null> {
  try {
    const target = await fs.resolve(dir)
    const entries = await fs.listDir(target)
    return entries.map(e => e.name)
  } catch {
    return null
  }
}

async function copySkills(fs: FileSystem, skillsDir: string, root: string): Promise<number> {
  let count = 0
  let names: string[] = []
  try {
    names = await readdir(skillsDir)
  } catch {
    return count
  }
  for (const name of names) {
    if (!/^[a-z0-9-]+$/.test(name)) continue
    try {
      const body = await readFile(nodePath.join(skillsDir, name, 'SKILL.md'), 'utf8')
      const target = await fs.resolve(nodePath.join(root, '.dsh', 'skills', name, 'SKILL.md'))
      await fs.writeText(target, body)
      count += 1
    } catch {
      // 该目录不是技能包，跳过。
    }
  }
  return count
}

function initGit(root: string): { git: InitOutcome['git']; gitDetail?: string } {
  const init = spawnCommand('git', ['init', '-q'], { cwd: root })
  if (!init.ok) return { git: 'failed', gitDetail: describeFailure('git init', init) }
  const add = spawnCommand('git', ['add', '-A'], { cwd: root })
  if (!add.ok) return { git: 'failed', gitDetail: describeFailure('git add', add) }
  const commit = spawnCommand(
    'git',
    ['-c', 'user.name=dsh-thesis', '-c', 'user.email=dsh-thesis@local', 'commit', '-q', '-m', 'chore: dsh-thesis 初始化论文工作区'],
    { cwd: root },
  )
  if (!commit.ok) return { git: 'failed', gitDetail: describeFailure('git commit', commit) }
  return { git: 'ok' }
}

export async function runInit(fs: FileSystem, args: InitArgs, skillsDir: string, signal?: AbortSignal): Promise<InitOutcome> {
  if (args.root === undefined || args.root.trim() === '') {
    throw new Error('root 参数必填：论文工作区根目录的绝对路径。')
  }
  if (!nodePath.isAbsolute(args.root)) {
    throw new Error(`root 必须是绝对路径，收到：${args.root}。`)
  }
  const root = nodePath.normalize(args.root)

  const existing = await dirEntries(fs, root)
  if (existing !== null && existing.length > 0 && args.force !== true) {
    throw new Error(
      `目录 ${root} 非空（已有 ${existing.length} 项）。为避免覆盖数据，请选择空目录或新目录；确认要写入现有目录请设 force: true（不会覆盖同名文件，仍会失败于冲突）。`,
    )
  }

  const now = new Date()
  const date = now.toISOString().slice(0, 10)
  const title = args.title?.trim() || '本科毕业设计'
  const files = buildLayout({ title, date })

  let written = 0
  for (const file of files) {
    const target = await fs.resolve(nodePath.join(root, file.path), { signal })
    await fs.writeText(target, file.content, undefined, signal)
    written += 1
  }

  const skills = await copySkills(fs, skillsDir, root)

  const gitResult = args.git === false ? { git: 'skipped' as const } : initGit(root)

  return { root, files: written, skills, ...gitResult }
}

export function initSummary(outcome: InitOutcome): string {
  const lines = [
    `论文工作区已创建：${outcome.root}`,
    `- 模板文件：${outcome.files} 个（含目录结构、进度台账、决定日志、章节模板）`,
    `- 技能包：${outcome.skills} 个（.dsh/skills/，随仓库版本化）`,
  ]
  if (outcome.git === 'ok') lines.push('- git：已初始化并完成首次提交')
  else if (outcome.git === 'skipped') lines.push('- git：按请求跳过初始化')
  else lines.push(`- git：初始化失败（${outcome.gitDetail ?? '未知原因'}），请手动执行 git init`)
  lines.push('')
  lines.push('下一步：让 AI 运行"选题工作坊"（thesis-opener 技能），从阶段 1 开始。')
  return lines.join('\n')
}
