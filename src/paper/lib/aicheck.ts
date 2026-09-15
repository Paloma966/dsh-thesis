/**
 * AI 味自查（thesis_stylecheck 的核心）：确定性启发式扫描。
 *
 * 六条规则，全部基于文本特征，可复现：
 * 1. 模板套话（"综上所述/众所周知/随着…的发展"等清单）
 * 2. 空洞结论句（"具有一定的意义"类）
 * 3. 自我暴露（正文出现 AI/大语言模型等表述 —— 错误级）
 * 4. 翻译腔（"被用于/进行了…的/一个…的过程"等）
 * 5. 句式单一（连续 3 段以上以同一开头）
 * 6. 无锚点段落（长段落无数字、无引用、无图表、无具体对象）
 *
 * 本工具是"自查"，不是"证明"：命中项给出改写方向，最终是否修改由用户
 * 在 G2/G4 关卡决定。改写建议与 thesis-writing 技能 §4 的去 AI 味规则一致。
 */

export interface AiFindingItem {
  readonly excerpt: string
  readonly line: number
}

export interface AiFinding {
  readonly rule: string
  readonly level: 'error' | 'warn'
  readonly advice: string
  readonly items: readonly AiFindingItem[]
}

export interface AiChapterReport {
  readonly chapter: string
  readonly findings: readonly AiFinding[]
}

// ---------------------------------------------------------------------------
// 规则定义
// ---------------------------------------------------------------------------

interface RuleDef {
  readonly name: string
  readonly level: 'error' | 'warn'
  readonly advice: string
  /** 文本级规则；返回命中片段列表，无命中返回 null。 */
  readonly test?: (text: string) => string[] | null
  /** 跨段落规则（句式单一）专用。 */
  readonly paragraphs?: (paragraphs: readonly ParaInfo[]) => AiFindingItem[]
}

interface ParaInfo {
  readonly text: string
  readonly line: number
}

const CLICHES = [
  '综上所述', '总而言之', '众所周知', '值得注意的是', '不难发现', '显而易见',
  '在当今', '近年来', '意义重大', '迫在眉睫', '不可或缺', '日益重要', '突飞猛进', '日新月异',
]

const RULES: readonly RuleDef[] = [
  {
    name: '模板套话',
    level: 'warn',
    advice: '删除或改写为具体内容：套话不携带信息，是 AI 检测的重点信号。',
    test: (text) => {
      const hits = new Set<string>()
      for (const phrase of CLICHES) {
        if (text.includes(phrase)) hits.add(`"${phrase}"`)
      }
      for (const m of text.matchAll(/随着[\u4e00-\u9fff]{2,20}的(发展|进步|普及|应用)/g)) hits.add(`"${m[0]}"`)
      return hits.size > 0 ? [...hits] : null
    },
  },
  {
    name: '空洞结论句',
    level: 'warn',
    advice: '"具有一定的意义"没有信息量。改为具体结论：解决了什么问题、带来了什么可度量的效果。',
    test: (text) => {
      const hits = new Set<string>()
      for (const m of text.matchAll(/(具有|有着)(一定的|重要的|较大的|深远的)?(意义|价值|作用)/g)) hits.add(m[0])
      return hits.size > 0 ? [...hits] : null
    },
  },
  {
    name: '自我暴露',
    level: 'error',
    advice: '论文正文不得出现 AI 工具表述。删除该句；若确需说明工具使用，放在致谢或按学校规定位置，并先与导师沟通。',
    test: (text) => {
      const hits = new Set<string>()
      for (const m of text.matchAll(/作为\s*AI|人工智能助手|大语言模型|大型语言模型|语言模型生成|ChatGPT|由\s*AI\s*(生成|撰写|完成)/gi)) hits.add(m[0])
      return hits.size > 0 ? [...hits] : null
    },
  },
  {
    name: '翻译腔',
    level: 'warn',
    advice: '改为自然中文表达："被用于"→"用于/用来"；"进行了…的研究"→"研究了…"；"一个…的过程"→直接说动作。',
    test: (text) => {
      const hits = new Set<string>()
      const patterns = [
        /被用于/g,
        /对[\u4e00-\u9fff]{2,20}进行了/g,
        /进行了[\u4e00-\u9fff]{2,20}的/g,
        /一个[\u4e00-\u9fff]{2,10}的过程/g,
        /基于[\u4e00-\u9fff]{2,20}的基础(之上)?/g,
        /进行(深入)?的(研究|分析|探讨)/g,
      ]
      for (const pattern of patterns) {
        for (const m of text.matchAll(pattern)) hits.add(m[0])
      }
      return hits.size > 0 ? [...hits] : null
    },
  },
  {
    name: '句式单一',
    level: 'warn',
    advice: '连续多段以同一短语开头会暴露模式化生成。变换段落开头方式：从结论、对象、转折或数据切入。',
    paragraphs: (paragraphs) => {
      const items: AiFindingItem[] = []
      let runStart = 0
      let runKey = ''
      let runCount = 0
      const flush = () => {
        if (runCount >= 3) {
          items.push({
            excerpt: `连续 ${runCount} 段以"${runKey.slice(0, 12)}"开头`,
            line: paragraphs[runStart]!.line,
          })
        }
      }
      for (const para of paragraphs) {
        const key = para.text.slice(0, 6)
        if (key === runKey) {
          runCount += 1
        } else {
          flush()
          runKey = key
          runStart = paragraphs.indexOf(para)
          runCount = 1
        }
      }
      flush()
      return items
    },
  },
]

// ---------------------------------------------------------------------------
// 段落切分与扫描
// ---------------------------------------------------------------------------

function bodyParagraphs(chapterText: string): ParaInfo[] {
  const paragraphs: ParaInfo[] = []
  const lines = chapterText.split('\n')
  let start = -1
  const flush = (end: number) => {
    if (start >= 0) {
      const block = lines.slice(start, end).map(l => l.trim()).filter(l => l !== '' && !l.startsWith('|') && !l.startsWith('- ')).join('')
      if (block.length > 20) paragraphs.push({ text: block, line: start + 1 })
    }
  }
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!
    if (line.trim() === '') {
      flush(i)
      start = -1
      continue
    }
    if (/^#{1,6}\s/.test(line)) {
      flush(i)
      start = -1
      continue
    }
    if (start < 0) start = i
  }
  flush(lines.length)
  return paragraphs
}

function lineOf(text: string, needle: string): number {
  const idx = text.indexOf(needle)
  if (idx < 0) return 0
  return text.slice(0, idx).split('\n').length
}

function scanChapter(chapterText: string): AiFinding[] {
  const findings: AiFinding[] = []
  const paragraphs = bodyParagraphs(chapterText)
  const paragraphText = paragraphs.map(p => p.text).join('\n')

  for (const rule of RULES) {
    let items: AiFindingItem[] = []
    if (rule.test !== undefined) {
      const hits = rule.test(paragraphText)
      if (hits !== null) {
        items = hits.slice(0, 8).map(hit => ({ excerpt: hit, line: lineOf(chapterText, hit) }))
      }
    }
    if (rule.paragraphs !== undefined) {
      items = [...items, ...rule.paragraphs(paragraphs)]
    }
    if (items.length > 0) {
      findings.push({ rule: rule.name, level: rule.level, advice: rule.advice, items })
    }
  }

  // 无锚点段落（独立规则，需要逐段判断）
  const anchorless = paragraphs.filter(para => {
    const cjk = (para.text.match(/[\u4e00-\u9fff]/g) ?? []).length
    if (cjk < 100) return false
    const hasNumber = /\d/.test(para.text)
    const hasCitation = /\[\d/.test(para.text)
    const hasFigure = /[图表]\s*\d+-\d+/.test(para.text)
    const hasConcrete = /系统|模块|数据|实验|测试|本文|本系统|方法|算法|模型|接口|数据库|页面|功能/.test(para.text)
    return !hasNumber && !hasCitation && !hasFigure && !hasConcrete
  })
  if (anchorless.length > 0) {
    findings.push({
      rule: '无锚点段落',
      level: 'warn',
      advice: '长段落没有任何具体锚点（数字/引用/图表/具体对象），是"泛泛而谈"的信号。落到本课题的具体模块、数据或现象上，或拆分改写。',
      items: anchorless.slice(0, 5).map(para => ({ excerpt: para.text.slice(0, 40), line: para.line })),
    })
  }

  return findings
}

export interface AiSelfcheckReport {
  readonly chapters: readonly AiChapterReport[]
  readonly totalFindings: number
  readonly errorCount: number
}

export function runAiSelfcheck(chapters: readonly { name: string; text: string }[]): AiSelfcheckReport {
  const chapterReports = chapters.map(chapter => ({ chapter: chapter.name, findings: scanChapter(chapter.text) }))
  let total = 0
  let errors = 0
  for (const report of chapterReports) {
    for (const finding of report.findings) {
      total += finding.items.length
      if (finding.level === 'error') errors += finding.items.length
    }
  }
  return { chapters: chapterReports, totalFindings: total, errorCount: errors }
}

export function renderAiSelfcheck(report: AiSelfcheckReport, now: Date = new Date()): string {
  const lines: string[] = []
  lines.push('# AI 味自查报告')
  lines.push('')
  lines.push(`> 工具：thesis_stylecheck；生成时间：${now.toISOString()}`)
  lines.push('> 本报告是启发式自查，不是检测结论；命中项请结合 thesis-writing 技能 §4 逐条改写。')
  lines.push('')
  lines.push('## 总览')
  lines.push('')
  lines.push(`- 命中：${report.totalFindings} 处；其中错误级 ${report.errorCount} 处`)
  lines.push(`- 错误级（自我暴露）必须处理；警告级逐条判断后改写`)
  lines.push('')
  const withFindings = report.chapters.filter(c => c.findings.length > 0)
  if (withFindings.length === 0) {
    lines.push('## 各章明细')
    lines.push('')
    lines.push('全部章节未命中任何规则。仍需注意：启发式检查无法覆盖全部 AI 特征，最终以学校检测结果为准。')
  }
  for (const chapter of withFindings) {
    lines.push(`## ${chapter.chapter}`)
    lines.push('')
    for (const finding of chapter.findings) {
      lines.push(`### ${finding.level === 'error' ? '✗' : '⚠'} ${finding.rule}（${finding.items.length} 处）`)
      lines.push('')
      for (const item of finding.items) {
        lines.push(`- 第 ${item.line} 行附近：${item.excerpt}`)
      }
      lines.push('')
      lines.push(`改写建议：${finding.advice}`)
      lines.push('')
    }
  }
  lines.push('## 自查结论（用户填写）')
  lines.push('')
  lines.push('- [ ] 我已逐条处理上述命中项，并对全文做过一轮人工通读与修改')
  lines.push('- [ ] 确认人：________ 日期：________')
  lines.push('')
  return lines.join('\n')
}
