/**
 * thesis_defense：提取答辩素材 + 生成预答辩问题库骨架。
 *
 * 产出（写入 07-答辩/）：
 * - 答辩素材.md —— 课题/章节概览/技术选型/关键决定/测试数据/git 工作量/文献
 * - 预答辩问题库.md —— 六类必问问题模板 + 证据锚点
 * 具体问题生成与模拟问答由 AI（依据素材）与用户完成，流程见技能 thesis-defense。
 */

import * as nodePath from 'node:path'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { parseBibKeysOrdered } from '../lib/bibtex.ts'
import {
  countTestCases,
  extractDecisionTitles,
  extractHeadings,
  extractTechChoices,
  renderDefenseMaterials,
  renderQuestionBank,
  spawnGitStats,
  type GitRunner,
} from '../lib/defense.ts'
import { CHAPTER_META, isWrittenChapter } from '../lib/layout.ts'
import { parseLedger } from '../lib/ledger.ts'
import { findThesisRoot } from '../lib/project.ts'

export async function runDefensePrep(
  fs: FileSystem,
  cwd: string | undefined,
  signal: AbortSignal | undefined,
  gitRunner: GitRunner = spawnGitStats,
): Promise<string> {
  const root = await findThesisRoot(fs, cwd, signal)
  if (root === null) throw new Error('未找到论文工作区。请先在论文仓库目录内操作。')
  const rootDir: string = root

  async function readOptional(rel: string): Promise<string> {
    try {
      return await fs.readText(await fs.resolve(nodePath.join(rootDir, rel), { signal }), signal)
    } catch {
      return ''
    }
  }

  let title = '本科毕业论文（设计）'
  const ledger = parseLedger(await readOptional('00-管理/进度台账.md'))
  if (ledger.found && ledger.state.title !== undefined && ledger.state.title !== '') title = ledger.state.title

  // 章节概览（只统计已撰写章节）
  const chapters = []
  for (const [index, meta] of CHAPTER_META.entries()) {
    const text = await readOptional(nodePath.join('06-论文/章节', `${meta.file}.md`))
    if (!isWrittenChapter(text, index + 1, meta)) continue
    chapters.push({
      name: meta.file,
      no: index + 1,
      title: meta.title,
      cjk: (text.match(/[\u4e00-\u9fff]/g) ?? []).length,
      headings: extractHeadings(text),
      citations: (text.match(/\[\d+(?:[-,，]\d+)*\]/g) ?? []).length,
    })
  }

  const techChoices = extractTechChoices(await readOptional('03-设计/技术选型论证.md'))
  const decisions = extractDecisionTitles(await readOptional('00-管理/决定日志.md'))
  const testCases = countTestCases(await readOptional('05-实验测试/测试计划.md'))

  let resultFiles: string[] = []
  try {
    const entries = await fs.listDir(await fs.resolve(nodePath.join(root, '05-实验测试/结果'), { signal }), signal)
    resultFiles = entries.map(e => e.name).filter(n => !n.startsWith('.'))
  } catch {
    // 结果目录缺失：素材里如实提示。
  }

  const bibCount = parseBibKeysOrdered(await readOptional('02-文献/refs.bib')).length
  const git = gitRunner(root)

  const materials = renderDefenseMaterials({ title, chapters, techChoices, decisions, testCases, resultFiles, bibCount, git })
  const questions = renderQuestionBank(title)

  await fs.writeText(await fs.resolve(nodePath.join(root, '07-答辩/答辩素材.md'), { signal }), materials, undefined, signal)
  await fs.writeText(await fs.resolve(nodePath.join(root, '07-答辩/预答辩问题库.md'), { signal }), questions, undefined, signal)

  return [
    `答辩素材与问题库已生成：`,
    `- 07-答辩/答辩素材.md（课题"${title}"；已撰写 ${chapters.length} 章；技术选型 ${techChoices.length} 项；决定 ${decisions.length} 条；测试用例 ${testCases} 个；git ${git.ok ? `${git.commits} 次提交` : '统计不可用'}）`,
    `- 07-答辩/预答辩问题库.md（六类 ${questions.match(/- \[ \]/g)?.length ?? 0} 个问题骨架）`,
    '',
    '下一步（流程见技能 thesis-defense）：',
    '1. AI 依据《答辩素材》把问题库的 <> 占位替换为你的系统实际名称，生成 15-20 个具体问题',
    '2. 你逐题回答，答不上的回对应材料补学；至少完整演练 2 轮，第 2 轮随机抽题',
    '3. 演练完成后更新 07-答辩/问答演练.md，并用 thesis_progress 推进阶段 9 任务',
  ].join('\n')
}
