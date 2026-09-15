/**
 * 斜杠命令：`/thesis-ingest`。
 *
 * 命令名遵循 DSH 的 `[a-z][a-z0-9_-]*` 约束（kebab-case），与 `/thesis-check` 等同一套写法。
 * 命令只是 `thesis_ingest` 工具的薄封装：把命令行输入解析成 `IngestArgs` 后交给 `runIngest`，
 * 因此行为与工具**完全一致**。
 *
 * @module dsh-thesis/ingest
 */

import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { IngestOptions } from '../config.ts'
import { diskIO, renderOutcome, runIngest, type IngestArgs } from './index.ts'

async function safe(work: () => Promise<string>): Promise<CommandResult> {
  try {
    return { kind: 'success', text: await work() }
  } catch (error) {
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 解析 `/thesis-ingest` 的输入。
 *
 * 用法：`/thesis-ingest <绝对路径> [--glob docx,pdf] [--dry]`
 * - `<绝对路径>`：文件或目录（目录递归；源码目录会产出代码结构摘要）
 * - `--glob`：后缀过滤，逗号分隔
 * - `--dry`：只读不落盘（不写材料清单与摘要文件）
 */
export function parseIngestCommandInput(rawInput: string): IngestArgs {
  const tokens = rawInput.trim().split(/\s+/).filter(token => token !== '')
  let path: string | undefined
  let glob: string | undefined
  let write = true

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!
    const lowered = token.toLowerCase()
    if (lowered === '--glob' || lowered === '-g') {
      glob = tokens[++index]
      if (glob === undefined) throw new Error('--glob 后面要跟后缀列表，如 --glob docx,pdf')
      continue
    }
    if (lowered === '--dry' || lowered === '--no-write') {
      write = false
      continue
    }
    if (token.startsWith('-')) throw new Error(`无法识别的选项「${token}」`)
    if (path !== undefined) throw new Error(`只能指定一个路径（多余的是「${token}」）`)
    path = token
  }

  if (path === undefined) {
    throw new Error('用法：/thesis-ingest <绝对路径> [--glob docx,pdf] [--dry]')
  }
  return {
    path,
    ...(glob !== undefined ? { glob } : {}),
    ...(write ? {} : { write: false }),
  }
}

/** 构造 `/thesis-ingest` 命令定义。 */
export function ingestCommand(fs: FileSystem, options: IngestOptions): unknown {
  return {
    name: 'thesis-ingest',
    description: '摄取材料：docx/xlsx/pptx/pdf/md/csv/bib + 源码目录 → 文本与代码结构摘要，写 00-管理/材料清单.md',
    input: { hint: '<绝对路径> [--glob docx,pdf] [--dry]' },
    async handler(invocation: CommandInvocation): Promise<CommandResult> {
      return await safe(async () => {
        const args = parseIngestCommandInput(invocation.rawInput)
        const outcome = await runIngest(
          fs,
          diskIO,
          args,
          invocation.agent.session.header.cwd,
          options,
          invocation.signal,
        )
        return renderOutcome(outcome, options.maxChars)
      })
    },
  }
}
