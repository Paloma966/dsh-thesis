/**
 * 斜杠命令：`/thesis-originality`。
 *
 * 命令名遵循 DSH 的 `[a-z][a-z0-9_-]*` 约束（kebab-case），与 `/thesis-check` 等同一套写法。
 * 命令只是 `thesis_originality` 工具的薄封装：把命令行输入解析成 `DedupArgs` 后交给 `runDedup`，
 * 因此行为与工具**完全一致**，不存在"命令和工具两条逻辑"的漂移。
 *
 * @module dsh-thesis/dedup
 */

import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { SimilarityOptions } from '../config.ts'
import { runDedup, type DedupArgs } from './index.ts'

const ACTIONS: readonly DedupArgs['action'][] = ['scan', 'verify', 'report']

async function safe(work: () => Promise<string>): Promise<CommandResult> {
  try {
    return { kind: 'success', text: await work() }
  } catch (error) {
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 解析 `/thesis-originality` 的输入。
 *
 * 支持：`scan|verify|report`、位置参数（语料路径）、`--chapter <章节>`、
 * `--baseline <报告路径>`、`--rate <重复率>`、`--system <检测系统名>`。
 */
export function parseDedupCommandInput(rawInput: string): DedupArgs {
  const tokens = rawInput.trim().split(/\s+/).filter(token => token !== '')
  let action: DedupArgs['action'] = 'scan'
  const paths: string[] = []
  let chapter: string | undefined
  let baseline: string | undefined
  let detectedRate: number | undefined
  let detectedSystem: string | undefined

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!
    const lowered = token.toLowerCase()
    if (ACTIONS.includes(lowered as DedupArgs['action'])) {
      action = lowered as DedupArgs['action']
      continue
    }
    if (lowered === '--chapter' || lowered === '-c') {
      chapter = tokens[++index]
      if (chapter === undefined) throw new Error('--chapter 后面要跟章节名，如 --chapter 01-绪论')
      continue
    }
    if (lowered === '--baseline' || lowered === '-b') {
      baseline = tokens[++index]
      if (baseline === undefined) throw new Error('--baseline 后面要跟报告路径')
      continue
    }
    if (lowered === '--rate' || lowered === '-r') {
      const raw = tokens[++index]
      const rate = raw === undefined ? Number.NaN : Number.parseFloat(raw)
      if (!Number.isFinite(rate)) throw new Error('--rate 后面要跟数字，如 --rate 12 或 --rate 0.12')
      detectedRate = rate
      continue
    }
    if (lowered === '--system' || lowered === '-s') {
      detectedSystem = tokens[++index]
      if (detectedSystem === undefined) throw new Error('--system 后面要跟检测系统名，如 --system 知网')
      continue
    }
    if (token.startsWith('-')) throw new Error(`无法识别的选项「${token}」`)
    paths.push(token)
  }

  return {
    action,
    ...(paths.length > 0 ? { corpus: paths.join(',') } : {}),
    ...(chapter !== undefined ? { chapter } : {}),
    ...(baseline !== undefined ? { baseline } : {}),
    ...(detectedRate !== undefined ? { detected_rate: detectedRate } : {}),
    ...(detectedSystem !== undefined ? { detected_system: detectedSystem } : {}),
  }
}

/** 构造 `/thesis-originality` 命令定义。 */
export function dedupCommand(fs: FileSystem, similarity: SimilarityOptions): unknown {
  return {
    name: 'thesis-originality',
    description: '原创性自查：本地相似度扫描（scan）/ 复测降幅（verify）/ 汇总并回填学校检测结果（report）；不接入收费查重系统',
    input: { hint: 'scan | verify | report [语料路径] [--chapter 01-绪论] [--rate 12] [--system 知网]' },
    async handler(invocation: CommandInvocation): Promise<CommandResult> {
      return await safe(async () => {
        const args = parseDedupCommandInput(invocation.rawInput)
        return await runDedup(fs, invocation.agent.session.header.cwd, args, similarity, invocation.signal)
      })
    },
  }
}
