/**
 * 幻灯质量检查（`thesis_slides action=check` 的核心）。
 *
 * 全部检查项都是**确定性**的（不调用模型）：页数区间、每页要点条数、单条要点
 * 字数、是否有讲稿、是否每页都有证据锚点、是否出现「待补充/TODO」、预计时长
 * 是否落在 8–12 分钟。每条问题都带页码与原文位置，便于逐条修。
 *
 * @module dsh-thesis/ppt
 */

import * as nodePath from 'node:path'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { MAX_BULLETS_PER_SLIDE, MAX_BULLET_CHARS, MAX_TITLE_CHARS, MIN_BULLETS_PER_SLIDE, audienceProfile, type Audience } from './outline.ts'
import { parseMarp, type ParsedDeck, type ParsedSlide } from './marp.ts'

/** 问题级别：error = 必须修；warn = 建议修。 */
export type IssueLevel = 'error' | 'warn'

/** 一条检查问题。 */
export interface SlideIssue {
  /** 稳定的问题代号（便于测试与逐条定位）。 */
  readonly code: string
  readonly level: IssueLevel
  /** 定位（如「第 3 页」）；全局问题为「全文」。 */
  readonly where: string
  readonly message: string
}

/** 质量检查结果。 */
export interface CheckResult {
  readonly pages: number
  readonly estimate: {
    readonly minMinutes: number
    readonly maxMinutes: number
    readonly secondsPerSlideMin: number
    readonly secondsPerSlideMax: number
  }
  readonly issues: readonly SlideIssue[]
  readonly errors: number
  readonly warnings: number
  /** 通过（无 error）时为 true。 */
  readonly ok: boolean
}

/** 每页预计时长的允许区间（分钟）。 */
export const DURATION_MIN_MINUTES = 8
export const DURATION_MAX_MINUTES = 12

/** 占位符/未完成标记（命中即提示）。 */
export const PLACEHOLDER_PATTERNS: readonly { readonly pattern: RegExp; readonly label: string }[] = [
  { pattern: /待补充/, label: '待补充' },
  { pattern: /待补\b|待填|待定/, label: '待填占位' },
  { pattern: /TODO|FIXME/, label: 'TODO/FIXME' },
  { pattern: /<[^>\s]{1,20}>/, label: '<> 模板占位' },
]

function textLength(text: string): number {
  return text.replace(/\s+/g, '').length
}

/**
 * 检查幻灯 Markdown 原文（确定性检查项全集）。
 *
 * `pages`/`audience` 用于判定页数区间与时长；`fs`/`root` 可选——提供了就顺便
 * 验证证据锚点指向的文件是否存在（缺失记 warn，不阻塞）。
 */
export function checkDeck(
  markdown: string,
  options: {
    readonly audience: Audience
    readonly fs?: FileSystem
    readonly root?: string
    readonly targetPages?: number
  },
): CheckResult {
  const deck: ParsedDeck = parseMarp(markdown)
  const profile = audienceProfile(options.audience)
  const issues: SlideIssue[] = []
  const pages = deck.slides.length

  const push = (code: string, level: IssueLevel, where: string, message: string): void => {
    issues.push({ code, level, where, message })
  }

  // 1. 页数区间
  const [minPages, maxPages] = profile.pages
  if (pages === 0) {
    push('deck-empty', 'error', '全文', '没有解析到任何幻灯片（每页需要一行 `## 标题` 与要点列表）。')
  } else if (pages < minPages) {
    push('deck-too-few-pages', 'error', '全文', `只有 ${pages} 页，少于${profile.label}答辩骨架要求的 ${minPages}-${maxPages} 页。`)
  } else if (pages > maxPages) {
    push('deck-too-many-pages', 'error', '全文', `共 ${pages} 页，超出${profile.label}答辩骨架的 ${minPages}-${maxPages} 页；删页而不是压缩讲述。`)
  }
  if (options.targetPages !== undefined && pages !== options.targetPages) {
    push('deck-page-mismatch', 'warn', '全文', `页数 ${pages} 与目标 ${options.targetPages} 页不一致。`)
  }

  // 2. frontmatter
  if (deck.theme === '') push('deck-theme-missing', 'warn', '全文', 'frontmatter 缺少 `theme:`，Marp 会退回默认主题。')

  // 3-6. 逐页
  for (const slide of deck.slides) {
    checkSlide(slide, push)
  }

  // 7. 时长
  const minMinutes = Math.max(1, Math.round((pages * profile.secondsMin) / 60))
  const maxMinutes = Math.max(1, Math.round((pages * profile.secondsMax) / 60))
  if (pages > 0 && maxMinutes > DURATION_MAX_MINUTES) {
    push(
      'time-over',
      'error',
      '全文',
      `预计时长 ${minMinutes}-${maxMinutes} 分钟，超出 ${DURATION_MIN_MINUTES}-${DURATION_MAX_MINUTES} 分钟的答辩窗口；删页或压缩每页讲述内容（每页 ${profile.secondsMin}-${profile.secondsMax} 秒）。`,
    )
  } else if (pages > 0 && minMinutes < DURATION_MIN_MINUTES) {
    push(
      'time-under',
      'warn',
      '全文',
      `预计时长 ${minMinutes}-${maxMinutes} 分钟，短于 ${DURATION_MIN_MINUTES} 分钟；老师一般要求讲满，建议把要点讲透或补一页实现细节。`,
    )
  }

  const errors = issues.filter(i => i.level === 'error').length
  const warnings = issues.filter(i => i.level === 'warn').length
  return {
    pages,
    estimate: {
      minMinutes,
      maxMinutes,
      secondsPerSlideMin: profile.secondsMin,
      secondsPerSlideMax: profile.secondsMax,
    },
    issues,
    errors,
    warnings,
    ok: errors === 0,
  }
}

function checkSlide(slide: ParsedSlide, push: (code: string, level: IssueLevel, where: string, message: string) => void): void {
  const where = `第 ${slide.index} 页「${slide.title}」`
  const titleChars = textLength(slide.title)
  // 封面/致谢页上的姓名、日期等占位符属正常（提交前替换），其余页面的占位符是必须修的问题。
  const placeholderTolerated = slide.index === 1 || /^(封面|致谢|致谢页|问答页|目录)$/.test(slide.title.trim())

  if (titleChars > MAX_TITLE_CHARS) {
    push('title-too-long', 'warn', where, `标题 ${titleChars} 字，超过 ${MAX_TITLE_CHARS} 字上限，会换行挤压版面。`)
  }
  if (slide.bullets.length < MIN_BULLETS_PER_SLIDE) {
    push('too-few-bullets', 'warn', where, `只有 ${slide.bullets.length} 条要点，建议 ${MIN_BULLETS_PER_SLIDE}-${MAX_BULLETS_PER_SLIDE} 条（一页一个观点）。`)
  }
  if (slide.bullets.length > MAX_BULLETS_PER_SLIDE) {
    push('too-many-bullets', 'error', where, `${slide.bullets.length} 条要点，超出每页 ${MAX_BULLETS_PER_SLIDE} 条上限。`)
  }
  for (const [i, bullet] of slide.bullets.entries()) {
    if (textLength(bullet.text) > MAX_BULLET_CHARS) {
      push('bullet-too-long', 'error', where, `第 ${i + 1} 条要点 ${textLength(bullet.text)} 字，超出 ${MAX_BULLET_CHARS} 字上限：${bullet.text.slice(0, 40)}…`)
    }
    if (bullet.truncated) {
      push('bullet-truncated', 'warn', where, `第 ${i + 1} 条要点在生成时被自动截断（标记「已截断」），请人工确认语义是否完整。`)
    }
    for (const { pattern, label } of PLACEHOLDER_PATTERNS) {
      if (pattern.test(bullet.text)) {
        const informational = placeholderTolerated && (label === '待填占位' || label === '<> 模板占位')
        push(
          'placeholder',
          informational ? 'warn' : 'error',
          where,
          `第 ${i + 1} 条要点含未完成标记「${label}」：${bullet.text}${informational ? '（封面/致谢页的占位符属正常，提交前替换）' : ''}`,
        )
      }
    }
    if (bullet.anchor === undefined || bullet.anchor.trim() === '') {
      push('missing-anchor', 'error', where, `第 ${i + 1} 条要点没有证据锚点（应指向真实文件/章节/数据，如 06-论文/章节/04-系统设计.md#架构）。`)
    } else if (/^材料|^见论文|^结论/.test(bullet.anchor.trim())) {
      push('vague-anchor', 'warn', where, `第 ${i + 1} 条要点的锚点过于笼统：${bullet.anchor}`)
    }
  }
  if (slide.note === undefined || slide.note.trim() === '') {
    push('missing-note', 'warn', where, '缺少讲稿要点（生成时应写入 `<!-- 讲稿：… -->` 注释，Marp 演示者备注用）。')
  }
}

/**
 * 证据锚点落盘校验（可选）：锚点形如 `相对路径#小节`，只校验路径部分是否存在。
 * 缺失记为 warn——素材尚未生成时会大量缺失，属于正常提示而非错误。
 */
export async function verifyAnchors(markdown: string, fs: FileSystem, root: string): Promise<SlideIssue[]> {
  const deck = parseMarp(markdown)
  const issues: SlideIssue[] = []
  const checked = new Map<string, boolean>()
  for (const slide of deck.slides) {
    for (const [i, bullet] of slide.bullets.entries()) {
      if (bullet.anchor === undefined || bullet.anchor.trim() === '') continue
      const rel = (bullet.anchor.split('#')[0] ?? '').trim()
      if (rel === '' || /^(git log|见论文|材料)/.test(rel)) continue
      let exists = checked.get(rel)
      if (exists === undefined) {
        exists = await fileExists(fs, joinPath(root, rel))
        checked.set(rel, exists)
      }
      if (!exists) {
        issues.push({
          code: 'anchor-file-missing',
          level: 'warn',
          where: `第 ${slide.index} 页「${slide.title}」`,
          message: `第 ${i + 1} 条要点的证据锚点指向的文件不存在：${rel}（素材未生成或路径已变；答辩前请补齐真实证据）`,
        })
      }
    }
  }
  return issues
}

function joinPath(root: string, rel: string): string {
  return nodePath.join(root, rel.replace(/^[\\/]+/, ''))
}

async function fileExists(fs: FileSystem, absPath: string): Promise<boolean> {
  try {
    await fs.readText(await fs.resolve(absPath), undefined)
    return true
  } catch {
    return false
  }
}

/** 检查结果的文本渲染（有界；工具返回值用）。 */
export function renderCheckReport(result: CheckResult, deckRelPath: string): string {
  const lines: string[] = []
  lines.push(`幻灯质量检查：${deckRelPath}`)
  lines.push(`- 页数：${result.pages} 页`)
  lines.push(`- 预计时长：${result.estimate.minMinutes}-${result.estimate.maxMinutes} 分钟（每页 ${result.estimate.secondsPerSlideMin}-${result.estimate.secondsPerSlideMax} 秒）`)
  lines.push(`- 结论：${result.ok ? '通过（无 error）' : `${result.errors} 条必须修、${result.warnings} 条建议修`}`)
  if (result.issues.length === 0) {
    lines.push('- 未发现问题。')
    return lines.join('\n')
  }
  lines.push('')
  lines.push('问题清单（逐条定位）：')
  for (const issue of result.issues) {
    lines.push(`- [${issue.level === 'error' ? '必须修' : '建议修'}] ${issue.where} · ${issue.code}：${issue.message}`)
  }
  return lines.join('\n')
}
