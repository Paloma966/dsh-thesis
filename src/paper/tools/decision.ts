/**
 * thesis_decide：决定日志追加（00-管理/决定日志.md）。
 *
 * 决定日志是答辩留痕的核心证据：每个关键决定记录内容、理由、备选。
 */

import * as nodePath from 'node:path'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { describeReadFailure, isMissingError } from '../../shared/fs-errors.ts'
import { appendDecision, countDecisions, type DecisionEntry } from '../lib/ledger.ts'
import { DECISION_REL, findThesisRoot } from '../lib/project.ts'

export interface DecisionArgs {
  title?: string
  content: string
  reason?: string
  alternatives?: string
}

const DECISION_HEADER = `# 决定日志

> 每个关键决定的留痕：内容、理由、备选。答辩时它是"我为什么这么写"的证据。
> 由 thesis_decide 工具或 /thesis-decide 命令追加。

`

function deriveTitle(content: string): string {
  const firstLine = content.split('\n')[0]!.trim()
  const base = firstLine.length > 0 ? firstLine : '未命名决定'
  return base.length > 24 ? `${base.slice(0, 24)}…` : base
}

export async function runDecision(fs: FileSystem, args: DecisionArgs, cwd: string | undefined, signal?: AbortSignal): Promise<string> {
  if (args.content === undefined || args.content.trim() === '') {
    throw new Error('content 必填：决定的实际内容。')
  }
  const root = await findThesisRoot(fs, cwd, signal)
  if (root === null) {
    throw new Error('未找到论文工作区（向上查找 00-管理/进度台账.md 失败）。请先用 thesis_init 创建工作区，或在论文仓库目录内操作。')
  }
  const path = nodePath.join(root, DECISION_REL)
  let raw: string
  try {
    raw = await fs.readText(await fs.resolve(path, { signal }), signal)
  } catch (error) {
    // 只有「确实还没有决定日志」才用表头开始：读失败时若继续，会把已有的决定全部覆盖掉。
    if (!isMissingError(error)) {
      throw new Error(describeReadFailure('决定日志（00-管理/决定日志.md）', path, error, signal))
    }
    raw = DECISION_HEADER
  }
  if (raw.trim() === '') raw = DECISION_HEADER

  const entry: DecisionEntry = {
    date: new Date().toISOString().slice(0, 10),
    title: args.title?.trim() || deriveTitle(args.content),
    content: args.content.trim(),
    ...(args.reason?.trim() ? { reason: args.reason.trim() } : {}),
    ...(args.alternatives?.trim() ? { alternatives: args.alternatives.trim() } : {}),
  }

  const next = appendDecision(raw, entry)
  await fs.writeText(await fs.resolve(path, { signal }), next, undefined, signal)
  return `已记录决定 #${countDecisions(next)}「${entry.title}」（${entry.date}）。决定日志：${path}`
}
