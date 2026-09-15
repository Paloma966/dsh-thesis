/**
 * thesis_progress：进度台账读写 + 人工关卡闸门（G1/G2/G3/G4）。
 *
 * 关卡是工具层强制，不是提示语：阶段入口关卡未通过时，该阶段任务
 * 拒绝进入 doing/done（lib/ledger.ts canUpdateTask）。通过关卡前，
 * 关联任务必须先 done（lib/ledger.ts applyGate）。
 */

import * as nodePath from 'node:path'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { describeReadFailure, isMissingError } from '../../shared/fs-errors.ts'
import {
  applyGate,
  applyTaskUpdate,
  GATE_NAMES,
  parseLedger,
  renderLedger,
  renderReport,
  type ThesisState,
} from '../lib/ledger.ts'
import { findThesisRoot, LEDGER_REL } from '../lib/project.ts'

export interface ProgressArgs {
  action: 'report' | 'update' | 'gate'
  task_id?: string
  status?: 'todo' | 'doing' | 'done'
  note?: string
  gate?: 'G1' | 'G2' | 'G3' | 'G4'
  pass?: boolean
  chapter?: string
}

async function loadLedger(fs: FileSystem, cwd: string | undefined, signal?: AbortSignal): Promise<{ root: string; state: ThesisState }> {
  const root = await findThesisRoot(fs, cwd, signal)
  if (root === null) {
    throw new Error(
      '未找到论文工作区（向上查找 00-管理/进度台账.md 失败）。请先用 thesis_init 创建工作区，或在论文仓库目录内操作。',
    )
  }
  const ledgerPath = nodePath.join(root, LEDGER_REL)
  let raw: string
  try {
    raw = await fs.readText(await fs.resolve(ledgerPath, { signal }), signal)
  } catch (error) {
    // 只有「台账确实不存在」才可以重建（工作区被手工删掉台账的异常情况）。
    // 读失败（权限/IO）时重建会把 25 条真实任务状态重置为初始态，且报告看起来一切正常——
    // 那是最坏的一种失败：学生以为进度没丢。
    if (!isMissingError(error)) {
      throw new Error(describeReadFailure('进度台账（00-管理/进度台账.md）', ledgerPath, error, signal))
    }
    const fresh = renderLedger(parseLedger('').state)
    await fs.writeText(await fs.resolve(ledgerPath, { signal }), fresh, undefined, signal)
    return { root, state: parseLedger(fresh).state }
  }
  const parsed = parseLedger(raw)
  if (!parsed.found) {
    throw new Error(
      '进度台账的 `<!-- thesis:state -->` 状态块缺失或损坏。请勿手工修改该 JSON 块；如被误改，可让 AI 依据默认任务清单重建。',
    )
  }
  return { root, state: parsed.state }
}

async function saveLedger(fs: FileSystem, root: string, state: ThesisState, signal?: AbortSignal): Promise<void> {
  const target = await fs.resolve(nodePath.join(root, LEDGER_REL), { signal })
  await fs.writeText(target, renderLedger(state), undefined, signal)
}

export async function runProgress(fs: FileSystem, args: ProgressArgs, cwd: string | undefined, signal?: AbortSignal): Promise<string> {
  switch (args.action) {
    case 'report': {
      const { state } = await loadLedger(fs, cwd, signal)
      return renderReport(state)
    }
    case 'update': {
      if (args.task_id === undefined || args.status === undefined) {
        throw new Error('update 需要 task_id 与 status（todo/doing/done）。')
      }
      const { root, state } = await loadLedger(fs, cwd, signal)
      const result = applyTaskUpdate(state, args.task_id, args.status, args.note)
      if (!result.ok) throw new Error(result.reason)
      await saveLedger(fs, root, state, signal)
      return `已更新：${result.task!.id} ${result.task!.title} → ${args.status}。\n${renderReport(state)}`
    }
    case 'gate': {
      if (args.gate === undefined || args.pass === undefined) {
        throw new Error('gate 需要 gate（G1/G2/G3/G4）与 pass（boolean）。')
      }
      const { root, state } = await loadLedger(fs, cwd, signal)
      const result = applyGate(state, args.gate, args.pass, { chapter: args.chapter, note: args.note })
      if (!result.ok) throw new Error(result.reason)
      await saveLedger(fs, root, state, signal)
      const name = GATE_NAMES[args.gate] ?? args.gate
      const extra = args.gate === 'G2' && args.chapter !== undefined ? `（${args.chapter}）` : ''
      return `关卡 ${args.gate} ${name}${extra} ${args.pass ? '已通过' : '已重置为未通过'}。\n${renderReport(state)}`
    }
    default: {
      throw new Error(`未知 action：${String(args.action)}。有效值：report、update、gate。`)
    }
  }
}
