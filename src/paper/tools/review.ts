/**
 * thesis_review：单章确定性评审（字数/大纲/引用/图表/未完成标记/G2 清单）。
 *
 * 评审的是"机器可证明"的部分；语义质量由 AI 依据 thesis-writing 技能完成，
 * 报告结论里会提示这一点。G2 人工验收流程见技能 thesis-pipeline / thesis-writing。
 */

import * as nodePath from 'node:path'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { chapterMetaFor } from '../lib/layout.ts'
import { REFS_BIB_REL } from '../lib/lit-cache.ts'
import { findThesisRoot } from '../lib/project.ts'
import { renderReviewReport, reviewChapter } from '../lib/review.ts'

export interface ReviewArgs {
  chapter: string
}

export async function runReview(fs: FileSystem, args: ReviewArgs, cwd: string | undefined, signal?: AbortSignal): Promise<string> {
  if (args.chapter === undefined || args.chapter.trim() === '') {
    throw new Error('chapter 必填：章节文件名，如 01-绪论（可带 .md）。')
  }
  const root = await findThesisRoot(fs, cwd, signal)
  if (root === null) {
    throw new Error('未找到论文工作区（向上查找 00-管理/进度台账.md 失败）。请先在论文仓库目录内操作。')
  }
  const located = chapterMetaFor(args.chapter.trim())
  if (located === undefined) {
    throw new Error(`未知章节：${args.chapter}。有效章节：01-绪论 至 07-总结与展望。`)
  }
  const chapterPath = nodePath.join(root, '06-论文/章节', `${located.meta.file}.md`)
  let chapterText: string
  try {
    chapterText = await fs.readText(await fs.resolve(chapterPath, { signal }), signal)
  } catch {
    throw new Error(`章节文件不存在：${chapterPath}。请先撰写该章（模板已由 thesis_init 生成，可能尚未动笔）。`)
  }
  let bibText = ''
  try {
    bibText = await fs.readText(await fs.resolve(nodePath.join(root, REFS_BIB_REL), { signal }), signal)
  } catch {
    // 文献库尚未建立：引用检查会如实报告 0 条。
  }
  const report = reviewChapter({ chapterText, bibText, meta: located.meta, chapterNo: located.chapterNo })
  return renderReviewReport(report)
}
