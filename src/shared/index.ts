/**
 * 跨模块共用的工具胶水：输出形状、会话定位、二进制落盘。
 *
 * 三个模块（论文流水线 / 记忆 / 新能力）都通过这里拿同一套约定，
 * 避免每个模块各写一份 `textOutput`/`sessionCwd` 造成的漂移。
 *
 * @module dsh-thesis/shared
 */

import { writeFile } from 'node:fs/promises'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'

export { definePaperTool, usingHostDefineTool, compileParameterSchema, compileValueSchema, type PaperToolOptions } from './define-tool.ts'

/** 统一的纯文本工具输出（本插件所有工具都返回有界字符串）。 */
export function textOutput() {
  return {
    schema: { type: 'string' as const },
    render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: String(value) }],
  }
}

/** 当前会话的工作目录；无 agent 的执行体（测试/程序化调用）返回 undefined。 */
export function sessionCwd(exec: ToolExecution): string | undefined {
  return exec.agent?.session.header.cwd
}

/** 二进制落盘签名（docx 等产出）。 */
export type WriteBinary = (absPath: string, data: Uint8Array) => Promise<void>

/**
 * 二进制落盘：`ctx.fs` 没有二进制写入能力，docx/pptx 由插件经 node:fs 写。
 * 这是文档化的例外，全插件只有这一处。
 */
export const writeBinary: WriteBinary = async (absPath, data) => {
  await writeFile(absPath, data)
}

/** 缩进渲染一个字符串列表，用于工具返回值里的人类可读清单。 */
export function bulletList(items: readonly string[], marker = '- '): string {
  return items.map(item => `${marker}${item}`).join('\n')
}
