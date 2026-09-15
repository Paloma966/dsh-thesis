/**
 * Marp Markdown 渲染（`thesis_slides action=outline` 的产出格式）。
 *
 * 输出目标：**标准 Marp 幻灯片 Markdown**，保证 `marp PPT.md --pptx` /
 * `npx @marp-team/marp-cli PPT.md --pptx` / `pandoc PPT.md -o PPT.pptx`
 * 可以直接消费。因此：
 * - frontmatter 只写 `marp/theme/paginate/size/header/footer` 六个键，值全部
 *   经过清洗（去引号、去换行、去 `---`），不可能破坏 YAML 头；
 * - 页间分隔符是独占一行的 `---`；正文里任何以 `---` 开头的行都会被转义；
 * - 讲稿写成 HTML 注释 `<!-- ... -->`（Marp 的演示者备注兼容形态）。
 *
 * @module dsh-thesis/ppt
 */

import { MAX_BULLETS_PER_SLIDE, type PlanBullet, type PlannedSlide, type SlidePlan } from './outline.ts'

/** 推荐主题名（Marp 内置主题 + 常见自定义主题）。 */
export const MARP_THEMES: readonly string[] = ['default', 'gaia', 'uncover', 'academic', 'dsh-thesis']

/** {@link renderMarp} 选项。 */
export interface MarpOptions {
  /** frontmatter 的 `theme:`；缺省 `default`。 */
  readonly theme?: string
  /** 页脚文字；缺省 `dsh-thesis`。 */
  readonly footer?: string
  /** 页眉文字；缺省用课题标题。 */
  readonly header?: string
  /** 是否写 `paginate: true`，缺省 true。 */
  readonly paginate?: boolean
}

/**
 * 清洗任意文本，使其可安全放进 Markdown 正文/HTML 注释：
 * 去掉换行与 HTML 注释定界符，行首 `---`/`#` 会被打散，避免误触发分页或标题。
 */
export function sanitizeInline(text: string): string {
  const flat = text.replace(/[\r\n]+/g, ' ').replace(/<!--|-->/g, ' ').replace(/\s+/g, ' ').trim()
  return flat.replace(/^---+/, '- —').replace(/^#{1,6}\s*/, '')
}

/** 清洗 YAML 标量：单行、去引号、去 `---`，保证 frontmatter 不被破坏。 */
export function sanitizeYamlScalar(text: string): string {
  const flat = sanitizeInline(text).replace(/["'`]/g, '').replace(/:/g, '：')
  return flat === '' ? 'untitled' : flat
}

/** 主题名只允许 `[A-Za-z0-9._-]`，其余替换为 `-`。 */
export function sanitizeTheme(theme: string | undefined): string {
  const raw = (theme ?? 'default').trim()
  const safe = raw.replace(/[^A-Za-z0-9._-]/g, '-')
  return safe === '' ? 'default' : safe
}

function frontmatter(plan: SlidePlan, options: MarpOptions): string[] {
  return [
    '---',
    'marp: true',
    `theme: ${sanitizeTheme(options.theme)}`,
    `paginate: ${options.paginate === false ? 'false' : 'true'}`,
    'size: 16:9',
    `header: ${sanitizeYamlScalar(options.header ?? plan.title)}`,
    `footer: ${sanitizeYamlScalar(options.footer ?? 'dsh-thesis')}`,
    '---',
  ]
}

/** 一条要点渲染为一行 Markdown 列表项（超长截断的要点带 `␣` 标记说明）。 */
export function renderBullet(bullet: PlanBullet): string {
  const text = sanitizeInline(bullet.text)
  const anchor = bullet.anchor !== undefined ? sanitizeInline(bullet.anchor) : ''
  const suffix = anchor !== '' ? ` <!-- 锚点: ${anchor} -->` : ''
  const mark = bullet.truncated ? '（已截断）' : ''
  return `- ${text}${mark}${suffix}`
}

/** 一页渲染为：标题 + 要点 + 讲稿注释。 */
export function renderSlide(slide: PlannedSlide): string {
  const lines: string[] = []
  lines.push(`## ${sanitizeInline(slide.title)}`)
  lines.push('')
  for (const bullet of slide.bullets.slice(0, MAX_BULLETS_PER_SLIDE)) lines.push(renderBullet(bullet))
  lines.push('')
  lines.push(`<!-- 讲稿：${sanitizeInline(slide.note)} -->`)
  return lines.join('\n')
}

/**
 * 渲染整份 Marp Markdown。
 *
 * 返回文本以 frontmatter 开头、以换行结尾；页间以 `---` 分隔，
 * 因此 `---` 独占行的出现次数 = 页数 - 1（frontmatter 的两条定界行不计入）。
 */
export function renderMarp(plan: SlidePlan, options: MarpOptions = {}): string {
  const blocks: string[] = []
  blocks.push(...frontmatter(plan, options))
  blocks.push('')
  const body = plan.slides.map(renderSlide).join('\n\n---\n\n')
  blocks.push(body)
  blocks.push('')
  return blocks.join('\n')
}

// ---------------------------------------------------------------------------
// 反向解析（check / convert 之前复核真实文件）
// ---------------------------------------------------------------------------

/** 从 Marp Markdown 里解析出的单页（用于质量检查）。 */
export interface ParsedSlide {
  readonly index: number
  readonly title: string
  readonly bullets: readonly { readonly text: string; readonly anchor?: string; readonly truncated: boolean }[]
  readonly note?: string
}

/** Marp Markdown 的解析结果。 */
export interface ParsedDeck {
  readonly title: string
  readonly theme: string
  readonly paginate: boolean
  readonly slides: readonly ParsedSlide[]
}

/** 提取 frontmatter 键值（只支持 `key: value` 单行标量）。 */
export function parseFrontmatter(markdown: string): { readonly fields: Record<string, string>; readonly body: string } {
  const lines = markdown.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return { fields: {}, body: markdown }
  let end = -1
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]?.trim() === '---') {
      end = i
      break
    }
  }
  if (end === -1) return { fields: {}, body: markdown }
  const fields: Record<string, string> = {}
  for (const raw of lines.slice(1, end)) {
    const matched = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(raw.trim())
    if (matched?.[1] !== undefined) fields[matched[1]] = (matched[2] ?? '').trim()
  }
  return { fields, body: lines.slice(end + 1).join('\n') }
}

/** 解析 Marp Markdown（含 frontmatter）为可检查的结构。 */
export function parseMarp(markdown: string): ParsedDeck {
  const { fields, body } = parseFrontmatter(markdown)
  const blocks: string[][] = [[]]
  for (const line of body.split(/\r?\n/)) {
    if (line.trim() === '---') {
      blocks.push([])
      continue
    }
    blocks[blocks.length - 1]!.push(line)
  }
  const slides: ParsedSlide[] = []
  for (const block of blocks) {
    const title = block.map(l => /^##\s+(.+)$/.exec(l.trim())?.[1]).find(v => v !== undefined)
    if (title === undefined) continue
    const bullets: { text: string; anchor?: string; truncated: boolean }[] = []
    let note: string | undefined
    for (const line of block) {
      const trimmed = line.trim()
      const noteMatched = /^<!--\s*讲稿[:：]\s*(.*?)\s*-->$/.exec(trimmed)
      if (noteMatched?.[1] !== undefined) {
        note = noteMatched[1]
        continue
      }
      if (!trimmed.startsWith('- ')) continue
      const anchorMatched = /<!--\s*锚点[:：]\s*(.*?)\s*-->/.exec(trimmed)
      const withoutAnchor = trimmed.replace(/<!--.*?-->/g, '').trim()
      const truncated = /（已截断）$/.test(withoutAnchor)
      const text = withoutAnchor.replace(/^-\s+/, '').replace(/（已截断）$/, '').trim()
      bullets.push({ text, ...(anchorMatched?.[1] !== undefined ? { anchor: anchorMatched[1] } : {}), truncated })
    }
    slides.push({
      index: slides.length + 1,
      title,
      bullets,
      ...(note !== undefined ? { note } : {}),
    })
  }
  return {
    title: fields.title ?? '',
    theme: fields.theme ?? '',
    paginate: (fields.paginate ?? 'true') !== 'false',
    slides,
  }
}

/** 检查 Marp Markdown 里是否会破坏 frontmatter/分页的字符。 */
export function findUnsafeMarkdown(markdown: string): string[] {
  const problems: string[] = []
  const { body } = parseFrontmatter(markdown)
  const lines = body.split(/\r?\n/)
  for (const [i, line] of lines.entries()) {
    if (/^\s*---/.test(line) && line.trim() !== '---') problems.push(`第 ${i + 1} 行：以 --- 开头的正文行会被误判为分页`)
    if (line.includes('<!-- 讲稿') && !/^<!--\s*讲稿[:：].*-->$/.test(line.trim())) problems.push(`第 ${i + 1} 行：讲稿注释形态不合法`)
  }
  if (!/^---\r?\nmarp:\s*true\s*$/m.test(markdown)) problems.push('frontmatter 首行必须是 marp: true')
  return problems
}
