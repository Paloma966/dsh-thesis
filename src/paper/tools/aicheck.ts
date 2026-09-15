/**
 * thesis_stylecheck：AI 味自查（六条启发式规则），
 * 报告写入 08-合规/AI味自查报告.md（稳定文件名，每次重跑覆盖）。
 */

import * as nodePath from 'node:path'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { renderAiSelfcheck, runAiSelfcheck } from '../lib/aicheck.ts'
import { CHAPTER_META, isWrittenChapter } from '../lib/layout.ts'
import { findThesisRoot } from '../lib/project.ts'

export async function runAiSelfcheckTool(fs: FileSystem, cwd: string | undefined, signal?: AbortSignal): Promise<string> {
  const root = await findThesisRoot(fs, cwd, signal)
  if (root === null) throw new Error('未找到论文工作区。请先在论文仓库目录内操作。')

  const chapters: { name: string; text: string }[] = []
  const missing: string[] = []
  for (const [index, meta] of CHAPTER_META.entries()) {
    let text: string | undefined
    try {
      text = await fs.readText(await fs.resolve(nodePath.join(root, '06-论文/章节', `${meta.file}.md`), { signal }), signal)
    } catch {
      text = undefined
    }
    if (text === undefined || !isWrittenChapter(text, index + 1, meta)) {
      missing.push(meta.file)
      continue
    }
    chapters.push({ name: meta.file, text })
  }

  const report = runAiSelfcheck(chapters)
  const rendered = renderAiSelfcheck(report)
  await fs.writeText(await fs.resolve(nodePath.join(root, '08-合规/AI味自查报告.md'), { signal }), rendered, undefined, signal)

  return [
    ...(missing.length > 0 ? [`⚠ 未撰写章节：${missing.join('、')}（不计入自查）。`, ''] : []),
    rendered,
    '',
    '报告已写入：08-合规/AI味自查报告.md',
  ].join('\n')
}
