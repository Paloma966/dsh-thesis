/**
 * 斜杠命令：/thesis-status 与 /thesis-decide。
 *
 * 注：DSH 命令名只允许 [a-z][a-z0-9_-]*，因此使用 kebab-case
 * （DESIGN.md 中的 /thesis:status 在此修正为 /thesis-status）。
 * 其余命令（/thesis-lit、/thesis-check、/thesis-build）随 M2/M4 工具一并注册。
 */

import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { writeFile } from 'node:fs/promises'
import { runDecision } from './tools/decision.ts'
import { runLitSearch } from './tools/lit.ts'
import { runProgress } from './tools/progress.ts'
import { buildSummary, runBuild } from './tools/build.ts'
import { runCheck } from './tools/check.ts'

function cwdOf(invocation: CommandInvocation): string | undefined {
  return invocation.agent.session.header.cwd
}

async function safe(work: () => Promise<string>): Promise<CommandResult> {
  try {
    return { kind: 'success', text: await work() }
  } catch (error) {
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
  }
}

export function statusCommand(fs: FileSystem): unknown {
  return {
    name: 'thesis-status',
    description: '查看毕业设计进度台账：当前阶段、人工关卡、任务状态',
    async handler(invocation: CommandInvocation): Promise<CommandResult> {
      return await safe(async () => runProgress(fs, { action: 'report' }, cwdOf(invocation), invocation.signal))
    },
  }
}

export function decideCommand(fs: FileSystem): unknown {
  return {
    name: 'thesis-decide',
    description: '记录一条关键决定（内容/理由/备选），写入决定日志',
    input: { hint: '决定内容' },
    async handler(invocation: CommandInvocation): Promise<CommandResult> {
      const content = invocation.rawInput.trim()
      if (content === '') {
        return { kind: 'error', text: '用法：/thesis-decide <决定内容>。内容不能为空。' }
      }
      return await safe(async () => runDecision(fs, { content }, cwdOf(invocation), invocation.signal))
    },
  }
}

export function litCommand(fs: FileSystem): unknown {
  return {
    name: 'thesis-lit',
    description: '从真实学术数据库检索文献（结果写入检索缓存与审计记录）',
    input: { hint: '检索关键词' },
    async handler(invocation: CommandInvocation): Promise<CommandResult> {
      const query = invocation.rawInput.trim()
      if (query === '') {
        return { kind: 'error', text: '用法：/thesis-lit <关键词>。例如 /thesis-lit 目标检测 小目标' }
      }
      return await safe(async () => runLitSearch(fs, { query, limit: 5 }, cwdOf(invocation), invocation.signal, fetch))
    },
  }
}

export function checkCommand(fs: FileSystem): unknown {
  return {
    name: 'thesis-check',
    description: '全文综合检查：引用/字数/图表/术语/模板，报告写入 08-合规/',
    async handler(invocation: CommandInvocation): Promise<CommandResult> {
      return await safe(async () => runCheck(fs, cwdOf(invocation), invocation.signal))
    },
  }
}

export function buildCommand(fs: FileSystem): unknown {
  return {
    name: 'thesis-build',
    description: '构建论文.docx（优先 pandoc + 学校模板，否则内置过渡引擎）',
    async handler(invocation: CommandInvocation): Promise<CommandResult> {
      return await safe(async () => {
        const outcome = await runBuild(fs, {}, cwdOf(invocation), invocation.signal, async (absPath, data) => {
          await writeFile(absPath, data)
        })
        return buildSummary(outcome)
      })
    },
  }
}
