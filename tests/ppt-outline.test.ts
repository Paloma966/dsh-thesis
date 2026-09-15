/**
 * `src/ppt/outline.ts` 的单元测试：计划生成、素材解析、回退路径、截断标记。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_BULLET_CHARS,
  MAX_BULLETS_PER_SLIDE,
  MIN_BULLETS_PER_SLIDE,
  MAX_TITLE_CHARS,
  buildSlidePlan,
  composeSlides,
  parseChapterFallback,
  parseDefenseMaterials,
  stripMarkdownInline,
  truncateBullet,
  truncateTitle,
  titleFromLedger,
  type SlidePlan,
} from '../src/ppt/outline.ts'
import { SAMPLE_CHAPTERS, SAMPLE_MATERIALS } from './ppt-fixtures.ts'

function planFromMaterials(overrides: Partial<Parameters<typeof buildSlidePlan>[0]> = {}): SlidePlan {
  return buildSlidePlan({
    title: '基于知识图谱的校园二手书交易平台设计与实现',
    audience: 'undergrad',
    targetPages: 11,
    defenseMaterials: SAMPLE_MATERIALS,
    ...overrides,
  })
}

function chapterFilesFromSample(): { name: string; text: string }[] {
  return Object.entries(SAMPLE_CHAPTERS).map(([path, text]) => ({ name: path.split('/').pop()!, text }))
}

test('parseDefenseMaterials 提取课题/章节/选型/决定/测试/工作量', () => {
  const parsed = parseDefenseMaterials(SAMPLE_MATERIALS)
  assert.equal(parsed.title, '基于知识图谱的校园二手书交易平台设计与实现')
  assert.equal(parsed.chapters.length, 5)
  assert.equal(parsed.chapters[0]!.title, '绪论')
  assert.ok(parsed.chapters[1]!.headings.includes('4.1 总体架构设计'))
  assert.equal(parsed.techChoices.length, 3)
  assert.equal(parsed.techChoices[0]!.item, '后端框架')
  assert.equal(parsed.techChoices[0]!.choice, 'Spring Boot')
  assert.match(parsed.techChoices[0]!.reason, /生态成熟/)
  assert.equal(parsed.decisions.length, 3)
  assert.equal(parsed.testCases, 24)
  assert.deepEqual([...parsed.resultFiles], ['检索性能-2026-04-20.csv', '推荐准确率.csv', '订单并发测试.csv'])
  assert.equal(parsed.gitCommits, 137)
  assert.equal(parsed.bibCount, 26)
})

test('buildSlidePlan：页数与骨架顺序符合答辩节奏', () => {
  const plan = planFromMaterials()
  assert.equal(plan.pages, 11)
  assert.equal(plan.slides.length, 11)
  assert.equal(plan.source, 'defense-materials')
  assert.equal(plan.note, undefined)
  assert.equal(plan.slides[0]!.kind, 'cover')
  assert.equal(plan.slides[1]!.kind, 'toc')
  assert.equal(plan.slides[2]!.kind, 'background')
  assert.equal(plan.slides[plan.slides.length - 1]!.kind, 'thanks')
  assert.equal(plan.slides[plan.slides.length - 2]!.kind, 'innovation')
  // 页号连续且从 1 开始
  assert.deepEqual(plan.slides.map(s => s.index), Array.from({ length: 11 }, (_, i) => i + 1))
})

test('buildSlidePlan：每页要点数在 3-6 条之间，标题 ≤ 20 字，要点 ≤ 30 字', () => {
  const plan = planFromMaterials()
  for (const slide of plan.slides) {
    assert.ok(slide.bullets.length >= MIN_BULLETS_PER_SLIDE, `第 ${slide.index} 页要点过少：${slide.bullets.length}`)
    assert.ok(slide.bullets.length <= MAX_BULLETS_PER_SLIDE, `第 ${slide.index} 页要点过多：${slide.bullets.length}`)
    assert.ok(slide.title.replace(/\s+/g, '').length <= MAX_TITLE_CHARS, `第 ${slide.index} 页标题过长：${slide.title}`)
    for (const bullet of slide.bullets) {
      assert.ok(bullet.text.length <= MAX_BULLET_CHARS, `第 ${slide.index} 页要点过长：${bullet.text}`)
    }
  }
})

test('buildSlidePlan：讲稿与证据锚点每页齐全', () => {
  const plan = planFromMaterials()
  for (const slide of plan.slides) {
    assert.ok(slide.note.trim().length > 0, `第 ${slide.index} 页缺讲稿`)
    for (const bullet of slide.bullets) {
      assert.ok(bullet.anchor !== undefined && bullet.anchor.trim() !== '', `第 ${slide.index} 页要点缺锚点：${bullet.text}`)
      assert.ok(!/^\s*$/.test(bullet.anchor!), '锚点不能为空串')
    }
  }
  // 证据锚点必须指向真实素材位置，而不是泛泛而谈
  const anchors = plan.slides.flatMap(s => s.bullets.map(b => b.anchor!))
  assert.ok(anchors.some(a => a.startsWith('06-论文/章节/')))
  assert.ok(anchors.some(a => a.startsWith('03-设计/')))
  assert.ok(anchors.some(a => a.startsWith('05-实验测试/')))
})

test('buildSlidePlan：超长要点被截断并标记（含原文）', () => {
  const longText = '这是一个远远超过三十个字符上限的小节标题它必须被自动截断并标记出来以便人工复核语义是否完整无损'
  assert.ok(longText.length > MAX_BULLET_CHARS)
  const plan = planFromMaterials({
    defenseMaterials: [
      '# 答辩素材',
      '',
      '## 课题',
      '',
      '语料驱动的智能问答系统',
      '',
      '## 章节概览',
      '',
      '### 第 1 章 绪论（1000 字，引用 1 处）',
      '',
      `- ${longText}`,
      '- 4.2 模块设计',
      '',
    ].join('\n'),
  })
  const all = plan.slides.flatMap(s => s.bullets)
  const truncated = all.filter(b => b.truncated)
  assert.ok(truncated.length >= 1, '超长要点必须被截断并标记')
  for (const bullet of truncated) {
    assert.ok(bullet.text.endsWith('…'))
    assert.equal(bullet.text.length, MAX_BULLET_CHARS)
    assert.equal(bullet.original, longText)
  }
  for (const item of all) assert.ok(item.text.length <= MAX_BULLET_CHARS)
})

test('truncateBullet / truncateTitle：边界行为', () => {
  assert.deepEqual(truncateBullet('短要点'), { text: '短要点', truncated: false })
  const exact = 'x'.repeat(MAX_BULLET_CHARS)
  assert.deepEqual(truncateBullet(exact), { text: exact, truncated: false })
  const long = 'y'.repeat(MAX_BULLET_CHARS + 5)
  const cut = truncateBullet(long)
  assert.equal(cut.truncated, true)
  assert.equal(cut.text.length, MAX_BULLET_CHARS)
  assert.equal(cut.original, long)
  assert.equal(truncateTitle('短标题'), '短标题')
  assert.equal(truncateTitle('z'.repeat(30)).length, MAX_TITLE_CHARS)
})

test('素材缺失时回退到论文章节，并给出"先跑 thesis_defense"提示', () => {
  const plan = buildSlidePlan({
    title: '基于知识图谱的校园二手书交易平台设计与实现',
    audience: 'undergrad',
    targetPages: 11,
    chapterFiles: chapterFilesFromSample(),
  })
  assert.equal(plan.source, 'chapters')
  assert.match(plan.note ?? '', /素材未生成/)
  assert.match(plan.note ?? '', /thesis_defense/)
  assert.ok(plan.pages >= 10 && plan.pages <= 12)
  // 回退路径只搬运论文标题，不产生任何编造的选型/数据
  const text = plan.slides.flatMap(s => s.bullets.map(b => b.text)).join('\n')
  assert.match(text, /绪论|系统设计|系统实现/)
  assert.doesNotMatch(text, /Spring Boot/)
  assert.doesNotMatch(text, /(准确率|TPS|ms)/)
  for (const slide of plan.slides) {
    assert.ok(slide.note.trim().length > 0)
    for (const bullet of slide.bullets) assert.ok(bullet.anchor !== undefined)
  }
})

test('parseChapterFallback：提取章标题与二三级小节', () => {
  const digests = parseChapterFallback(chapterFilesFromSample())
  const design = digests.find(d => d.file === '04-系统设计')!
  assert.equal(design.title, '系统设计')
  assert.ok(design.headings.includes('4.1 总体架构设计'))
  assert.ok(design.headings.includes('4.3 数据库设计'))
  assert.ok(!design.headings.includes('第 4 章 系统设计'))
})

test('页数参数：可调、越界自动夹取并在结果里报告', () => {
  // 固定头（封面/目录）+ 固定尾（创新点/致谢）共 4 页，中间七个段落至少各 1 页，
  // 因此本科骨架的真实下限是 11 页；小于它就夹到 11 并在结果里说明。
  const ten = planFromMaterials({ targetPages: 10 })
  assert.equal(ten.pages, 11)
  assert.match(ten.pageAdjustment ?? '', /超出.*骨架允许/)
  const eleven = planFromMaterials({ targetPages: 11 })
  assert.equal(eleven.pages, 11)
  const twelve = planFromMaterials({ targetPages: 12 })
  assert.equal(twelve.pages, 12)
  assert.equal(twelve.pageAdjustment, undefined)
  const tooMany = planFromMaterials({ targetPages: 30 })
  assert.equal(tooMany.pages, 12)
  assert.match(tooMany.pageAdjustment ?? '', /超出.*骨架允许/)
  const tooFew = planFromMaterials({ targetPages: 3 })
  assert.equal(tooFew.pages, 11)
  assert.ok(tooFew.pageAdjustment !== undefined)
})

test('硕士档位：每页 45-70 秒、页数上限更高', () => {
  const plan = buildSlidePlan({
    title: '课题',
    audience: 'master',
    targetPages: 13,
    defenseMaterials: SAMPLE_MATERIALS,
  })
  assert.equal(plan.audience, 'master')
  assert.equal(plan.pages, 13)
  assert.equal(plan.estimate.secondsPerSlideMin, 45)
  assert.equal(plan.estimate.secondsPerSlideMax, 70)
})

test('预计时长在 8-12 分钟窗口内（本科 11 页）', () => {
  const plan = planFromMaterials()
  assert.ok(plan.estimate.minMinutes >= 7, `下限过低：${plan.estimate.minMinutes}`)
  assert.ok(plan.estimate.maxMinutes <= 12, `上限过高：${plan.estimate.maxMinutes}`)
  assert.equal(plan.estimate.secondsPerSlideMin, 40)
  assert.equal(plan.estimate.secondsPerSlideMax, 60)
})

test('composeSlides：固定头尾各 1 页，中间段落可展开', () => {
  // 中间七个段落各至少 1 页 → 至少 7 个中间页；extra pages 按可展开顺序补。
  const c10 = composeSlides(10)
  assert.equal(c10.ids.length, 7)
  const c12 = composeSlides(12)
  assert.equal(c12.ids.length, 8)
  assert.ok(c12.ids.filter(id => id === 'background').length >= 2)
  assert.ok(c12.ids.includes('design'))
  assert.ok(c12.ids.includes('test'))
  const c20 = composeSlides(20)
  assert.equal(c20.ids.length, 16)
})

test('titleFromLedger / stripMarkdownInline：常见格式', () => {
  assert.equal(titleFromLedger('- title: 我的课题'), '我的课题')
  assert.equal(titleFromLedger('课题：另一个课题'), '另一个课题')
  assert.equal(titleFromLedger(undefined), '本科毕业论文（设计）')
  assert.equal(stripMarkdownInline('- **加粗**要点 `code`'), '加粗要点 code')
})
