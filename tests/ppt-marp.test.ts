/**
 * `src/ppt/marp.ts` 的单元测试：frontmatter 合法性、分页数、讲稿注释、
 * 破坏 frontmatter 的字符清洗、以及渲染 → 解析的往返一致性。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSlidePlan, type SlidePlan } from '../src/ppt/outline.ts'
import { findUnsafeMarkdown, parseFrontmatter, parseMarp, renderMarp, sanitizeTheme, sanitizeYamlScalar, MARP_THEMES } from '../src/ppt/marp.ts'
import { SAMPLE_MATERIALS } from './ppt-fixtures.ts'

function plan(overrides: Partial<Parameters<typeof buildSlidePlan>[0]> = {}): SlidePlan {
  return buildSlidePlan({
    title: '基于知识图谱的校园二手书交易平台设计与实现',
    audience: 'undergrad',
    targetPages: 11,
    defenseMaterials: SAMPLE_MATERIALS,
    ...overrides,
  })
}

test('renderMarp：frontmatter 合法且字段齐全', () => {
  const markdown = renderMarp(plan(), { theme: 'academic' })
  const { fields, body } = parseFrontmatter(markdown)
  assert.ok(body.length > 0)
  assert.equal(fields.marp, 'true')
  assert.equal(fields.theme, 'academic')
  assert.equal(fields.paginate, 'true')
  assert.equal(fields.size, '16:9')
  assert.equal(fields.header, '基于知识图谱的校园二手书交易平台设计与实现')
  assert.equal(fields.footer, 'dsh-thesis')
  assert.ok(markdown.startsWith('---\nmarp: true\n'), '首行必须是 frontmatter')
  // frontmatter 恰好由两行 --- 界定
  const head = markdown.split('\n').slice(0, 9)
  assert.equal(head.filter(l => l.trim() === '---').length, 2)
})

test('renderMarp：`---` 分页数 = 页数 - 1（加上 frontmatter 两条定界行）', () => {
  const p = plan()
  const markdown = renderMarp(p, { theme: 'default' })
  const { body } = parseFrontmatter(markdown)
  const separators = body.split(/\r?\n/).filter(line => line.trim() === '---').length
  assert.equal(separators, p.pages - 1)
  // 全文的 `---` 行数 = frontmatter 两条定界行 + 分页符（页数 - 1）
  const allSeparators = markdown.split('\n').filter(line => line.trim() === '---').length
  assert.equal(allSeparators, p.pages + 1)
})

test('renderMarp：讲稿写成 HTML 注释（Marp 演示者备注兼容）', () => {
  const p = plan()
  const markdown = renderMarp(p, {})
  const notes = markdown.match(/<!-- 讲稿：.+? -->/g) ?? []
  assert.equal(notes.length, p.pages)
  for (const note of notes) {
    assert.ok(!note.includes('\n'), '讲稿注释必须是单行')
    const inner = note.slice('<!-- '.length, -' -->'.length)
    assert.ok(!inner.includes('--'), `注释内容不得出现连续 --：${inner}`)
  }
  // 每一页的注释都出现在该页标题之后
  const blocks = parseFrontmatter(markdown).body.split(/\n---\n/)
  assert.equal(blocks.length, p.pages)
  for (const block of blocks) {
    assert.match(block, /## .+/)
    assert.match(block, /<!-- 讲稿：/)
  }
})

test('renderMarp：要点用 Markdown 列表，锚点随行注释保留', () => {
  const p = plan()
  const markdown = renderMarp(p, {})
  const deck = parseMarp(markdown)
  assert.equal(deck.slides.length, p.pages)
  for (const [i, slide] of deck.slides.entries()) {
    const source = p.slides[i]!
    assert.equal(slide.title, source.title)
    assert.equal(slide.bullets.length, source.bullets.length)
    for (const [j, bullet] of slide.bullets.entries()) {
      assert.equal(bullet.text, source.bullets[j]!.text)
      assert.equal(bullet.anchor, source.bullets[j]!.anchor)
    }
    assert.equal(slide.note, source.note)
  }
})

test('renderMarp：输出可被 marp --pptx 直接消费（无破坏 frontmatter 的字符）', () => {
  const markdown = renderMarp(plan(), { theme: 'default' })
  assert.deepEqual(findUnsafeMarkdown(markdown), [])
  // YAML 头里不得出现未转义的引号/冒号/换行破坏
  const { fields } = parseFrontmatter(markdown)
  for (const value of Object.values(fields)) assert.ok(!value.includes('\n'))
})

test('renderMarp：主题/页眉含危险字符时被清洗，frontmatter 不被破坏', () => {
  const evil = plan({ title: '课题：含冒号 "引号" 与 <尖括号>\n第二行 --- 注入' })
  const markdown = renderMarp(evil, { theme: 'my theme: "bad"\n---\ninjected: true', footer: '页脚\n---\n坏' })
  const { fields, body } = parseFrontmatter(markdown)
  assert.deepEqual(findUnsafeMarkdown(markdown), [])
  assert.equal(fields.theme, 'my-theme---bad------injected--true')
  assert.ok(!fields.header!.includes('\n'))
  assert.ok(!fields.footer!.includes('\n'))
  assert.ok(body.includes('---'))
  // frontmatter 只允许这六个键（marp/theme/paginate/size/header/footer）
  assert.equal(Object.keys(fields).length, 6)
})

test('sanitizeTheme / sanitizeYamlScalar：白名单与空值回退', () => {
  assert.equal(sanitizeTheme('gaia'), 'gaia')
  assert.equal(sanitizeTheme('my theme!'), 'my-theme-')
  assert.equal(sanitizeTheme(''), 'default')
  assert.equal(sanitizeTheme(undefined), 'default')
  assert.equal(sanitizeYamlScalar('  a: b  '), 'a： b')
  assert.equal(sanitizeYamlScalar('--- '), '- —')
  assert.equal(sanitizeYamlScalar(''), 'untitled')
  assert.ok(MARP_THEMES.includes('academic'))
})

test('renderMarp：超长要点带「已截断」标记，parseMarp 能读回', () => {
  const long = '这是一个超过三十字上限的要点它应当被截断并在渲染时带上已截断标记供人工复核'
  const p = buildSlidePlan({
    title: '课题',
    audience: 'undergrad',
    targetPages: 11,
    defenseMaterials: ['# 答辩素材', '', '## 课题', '', '课题', '', '## 章节概览', '', '### 第 1 章 绪论（900 字，引用 1 处）', '', `- ${long}`].join('\n'),
  })
  const markdown = renderMarp(p, {})
  assert.match(markdown, /（已截断）/)
  const deck = parseMarp(markdown)
  const truncated = deck.slides.flatMap(s => s.bullets).filter(b => b.truncated)
  assert.ok(truncated.length >= 1)
  assert.ok(truncated[0]!.text.endsWith('…'))
})

test('parseFrontmatter：无 frontmatter 时原样返回', () => {
  const { fields, body } = parseFrontmatter('# 标题\n\n正文')
  assert.deepEqual(fields, {})
  assert.equal(body, '# 标题\n\n正文')
})
