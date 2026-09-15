/**
 * thesis_check：全文综合检查（五项），产出两份报告：
 * - 08-合规/引用检查报告/检查-<date>.md（引用双向一致）
 * - 08-合规/格式检查报告/检查-<date>.md（字数/图表/术语/模板）
 */

import * as nodePath from 'node:path'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { runGlobalCheck, renderCheckReport, type CheckChapter } from '../lib/check.ts'
import { CHAPTER_META, isWrittenChapter } from '../lib/layout.ts'
import { REFS_BIB_REL } from '../lib/lit-cache.ts'
import { findThesisRoot } from '../lib/project.ts'

export async function runCheck(fs: FileSystem, cwd: string | undefined, signal?: AbortSignal): Promise<string> {
  const root = await findThesisRoot(fs, cwd, signal)
  if (root === null) throw new Error('未找到论文工作区。请先在论文仓库目录内操作。')

  // 章节收集（只检查"已撰写"章节，脚手架列入未撰写清单）
  const chapters: CheckChapter[] = []
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
    chapters.push({ name: meta.file, no: index + 1, text })
  }

  let bibText = ''
  try {
    bibText = await fs.readText(await fs.resolve(nodePath.join(root, REFS_BIB_REL), { signal }), signal)
  } catch {
    // 文献库缺失：引用检查会如实报告。
  }

  let templateFiles: string[] = []
  try {
    const entries = await fs.listDir(await fs.resolve(nodePath.join(root, '06-论文/assets/学校模板'), { signal }), signal)
    templateFiles = entries.map(e => e.name)
  } catch {
    // 目录缺失：模板检查会报告。
  }

  const report = runGlobalCheck({ chapters, bibText, templateFiles })
  const date = new Date().toISOString().slice(0, 10)

  // 引用检查报告
  const citationSection = report.sections.find(s => s.id === 'citations')!
  const citationReport = [
    `# 引用检查报告（${date}）`,
    '',
    '> 由 thesis_check 自动生成。检查：正文引用 ↔ refs.bib 双向一致。',
    '',
    `## ${citationSection.title}`,
    '',
    ...citationSection.lines,
    '',
  ].join('\n')
  await fs.writeText(await fs.resolve(nodePath.join(root, '08-合规/引用检查报告', `检查-${date}.md`), { signal }), citationReport, undefined, signal)

  // 格式检查报告
  const formatSections = report.sections.filter(s => s.id !== 'citations')
  const formatReport = [
    `# 格式检查报告（${date}）`,
    '',
    '> 由 thesis_check 自动生成。检查：字数、图/表编号、术语定义顺序、学校模板。',
    '',
    ...(missing.length > 0 ? [`⚠ 未撰写章节：${missing.join('、')}（不计入检查）。`, ''] : []),
    ...formatSections.flatMap(section => [`## ${section.title}`, '', ...section.lines, '']),
  ].join('\n')
  await fs.writeText(await fs.resolve(nodePath.join(root, '08-合规/格式检查报告', `检查-${date}.md`), { signal }), formatReport, undefined, signal)

  return [
    ...(missing.length > 0 ? [`⚠ 未撰写章节：${missing.join('、')}（不计入检查）。`, ''] : []),
    renderCheckReport(report),
    '',
    `报告已写入：08-合规/引用检查报告/检查-${date}.md、08-合规/格式检查报告/检查-${date}.md`,
  ].join('\n')
}
