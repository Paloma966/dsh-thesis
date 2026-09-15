/**
 * 论文工作区布局与全部模板文件内容（DESIGN.md §5 的落地）。
 *
 * thesis_init 按此生成目录树；模板内容与技能包（plugin/skills/）保持一致。
 * 本模块只依赖 Node 内置能力。
 */

import { defaultState, defaultTimeline, renderLedger, renderTimeline } from './ledger.ts'

export interface LayoutFile {
  /** 相对论文仓库根的路径（POSIX 分隔符）。 */
  readonly path: string
  readonly content: string
}

export interface LayoutOptions {
  readonly title: string
  readonly date: string
}

const HEADER_NOTE = '> 本文件由 thesis_init 生成；内容模板由 dsh-thesis 技能包指导填写。'

export function buildLayout(opts: LayoutOptions): LayoutFile[] {
  const files: LayoutFile[] = []

  // ------------------------------------------------------------------ 根
  files.push({
    path: 'README.md',
    content: `# ${opts.title}

${HEADER_NOTE}

## 这是什么

本仓库是毕业设计（计算机类）的完整工作区：选题、开题、文献、设计、实现、
论文、合规、答辩，全程留痕。

- 进度状态：见 \`00-管理/进度台账.md\`（由 \`thesis_progress\` 工具维护）
- 关键决定：见 \`00-管理/决定日志.md\`
- 流程地图：见 \`00-管理/流程地图.md\`

## 目录速览

| 目录 | 内容 |
|---|---|
| 00-管理 | 流程地图、选题、时间线、台账、决定日志 |
| 01-开题 | 开题报告、任务书 |
| 02-文献 | 文献库 refs.bib、检索记录、笔记 |
| 03-设计 | 需求分析、系统设计、技术选型论证 |
| 04-实现 | 真实代码 |
| 05-实验测试 | 测试计划与真实运行结果 |
| 06-论文 | 大纲、七章正文、图表、学校模板、产出 |
| 07-答辩 | PPT 大纲、问答演练 |
| 08-合规 | 格式/引用检查报告、自查报告 |

## 使用方式

在 DSH Web 界面中与本工作区配合使用：AI 会加载 \`.dsh/skills/\` 下的技能包，
按流程地图推进，并通过 \`thesis_progress\` / \`thesis_decide\` 工具维护台账与决定日志。
`,
  })

  files.push({
    path: '.gitignore',
    content: `# 依赖与构建产物
node_modules/
dist/
build/
__pycache__/
*.pyc

# 系统文件
.DS_Store
Thumbs.db

# 论文编译中间产物
*.aux
*.log
*.out
*.toc

# 文献检索缓存（临时候选，由 thesis_lit_search 维护）
02-文献/.lit-cache.json
`,
  })

  // ---------------------------------------------------------------- 00-管理
  files.push({
    path: '00-管理/流程地图.md',
    content: `# 毕业设计流程地图

${HEADER_NOTE}

九阶段全景。每个阶段：产出物 → 验收标准 → 下一站。详细方法论见技能包
\`thesis-pipeline\` / \`thesis-opener\` 等。

| 阶段 | 产出物 | 验收标准 | 人工关卡 |
|---|---|---|---|
| 1 选题 | 选题确认书 | 课题明确、工作量合理、答辩友好 | **G1** |
| 2 开题 | 开题报告 + 任务书 | 导师认可；报告结构与规范达标 | **G3** |
| 3 文献调研 | 文献库 + 笔记 + 综述素材 | 15-30 篇真实文献；每篇有笔记 | — |
| 4 系统设计 | 需求/设计/选型文档 | 方案可落地；选型有论证 | — |
| 5 系统实现 | 可运行系统 + git 提交 | 功能真实可跑；中期检查通过 | — |
| 6 系统测试 | 测试报告 + 真实结果 | 结果可复现；零伪造 | — |
| 7 论文撰写 | 七章正文 | 逐章人工验收 | **G2**（×7 章） |
| 8 定稿与合规 | 论文.docx + 检查报告 | 格式/引用/自查全部通过 | **G4** |
| 9 答辩 | PPT + 演练记录 | 能讲清设计与实现 | — |

**红线**（违反即学术不端，永不允许）：

1. 不得编造文献（每条引用必须来自真实检索，见 02-文献/检索记录.md）
2. 不得伪造数据/截图/运行结果（05-实验测试/结果 必须可在 04-实现 上复现）
3. 学校明文限制 AI 使用时，正文必须经过人工关卡（G1-G4）后提交

**每阶段结束的动作**：更新进度台账（\`thesis_progress\`）→ 关键决定写入决定日志
（\`thesis_decide\`）→ git 提交。
`,
  })

  files.push({
    path: '00-管理/选题/备选课题.md',
    content: `# 备选课题

${HEADER_NOTE}

选题工作坊产出：每个备选课题按"选题四要素"评估（兴趣 / 可行性 / 工作量 / 答辩友好度），
每项 1-5 分。评估由 \`thesis-opener\` 技能指导完成。

## 备选 A：<课题名>

- 一句话描述：
- 要解决的问题：
- 大致技术路线：
- 评估：
  - 兴趣：?/5
  - 可行性（你的基础 + AI 辅助可达成）：?/5
  - 工作量（与毕设周期匹配）：?/5
  - 答辩友好度（能讲清、有演示、有数据）：?/5
- 风险与对策：

## 备选 B：<课题名>

（同上）

## 备选 C：<课题名>

（同上）

## 结论

最终选择：<备选>。理由见《选题确认书》与决定日志。
`,
  })

  files.push({
    path: '00-管理/选题/选题确认书.md',
    content: `# 选题确认书

${HEADER_NOTE}

> 关卡 **G1** 的产物。本文件由用户书面确认后，G1 才能标记通过。

- 学生：<姓名>
- 课题：<课题名>
- 日期：${opts.date}

## 1. 课题动机

<为什么做这个课题：课程/兴趣/实际问题，2-3 句>

## 2. 要解决的问题

<用一句"用户/系统痛点 + 本课题的解法"来表述>

## 3. 技术路线概述

<用什么技术栈、大致分几步实现：一句话总览 + 3-5 个步骤>

## 4. 工作量评估

<功能范围：核心功能与可选功能；与毕设周期是否匹配>

## 5. 风险与对策

<最大风险是什么；如果做不出来，退路是什么>

## 6. 用户确认

- [ ] 我已理解上述课题内容与工作量，同意以此为毕业设计课题。
- 确认人：________ 日期：________
`,
  })

  files.push({
    path: '00-管理/时间线.md',
    content: renderTimeline(defaultTimeline()),
  })

  files.push({
    path: '00-管理/进度台账.md',
    content: renderLedger({ ...defaultState(), title: opts.title }),
  })

  files.push({
    path: '00-管理/决定日志.md',
    content: `# 决定日志

${HEADER_NOTE}

> 每个关键决定的留痕：内容、理由、备选。答辩时它是"我为什么这么写"的证据。
> 由 \`thesis_decide\` 工具或 /thesis-decide 命令追加。

（暂无决定）
`,
  })

  // ---------------------------------------------------------------- 01-开题
  files.push({
    path: '01-开题/开题报告.md',
    content: `# 开题报告

${HEADER_NOTE}

> 结构遵循 \`thesis-opener\` 技能；完稿后由 \`thesis_build\` 产出 docx。
> 提交前需通过关卡 **G3**。

## 1 课题背景与意义

<行业/领域背景 → 现有问题 → 本课题意义（建议 600-800 字）>

## 2 国内外研究现状

<按主题组织的文献综述，引用真实文献 [1][2]（建议 800-1200 字）>

## 3 研究内容与目标

<3-5 条具体研究内容，每条一句目标（建议 400-600 字）>

## 4 技术路线与方案

<总体方案图（可用 Mermaid）+ 分步说明 + 关键技术点（建议 600-800 字）>

## 5 进度安排

<表格：阶段 / 时间 / 产出（与 00-管理/时间线.md 一致）>

## 6 参考文献

<GB/T 7714 格式，全部来自 02-文献/refs.bib，此处手工同步或由构建工具自动生成>
`,
  })

  files.push({
    path: '01-开题/任务书.md',
    content: `# 任务书

${HEADER_NOTE}

> 各校模板不同；拿到学校模板后放 06-论文/assets/学校模板/，按模板重写本文件。

- 课题名称：
- 学生：
- 指导教师：

## 一、设计（研究）内容

## 二、主要技术指标或要求

## 三、进度安排

## 四、主要参考文献
`,
  })

  // ---------------------------------------------------------------- 02-文献
  files.push({
    path: '02-文献/refs.bib',
    content: `% 文献库（BibTeX）。
% 红线：本文件只收录真实检索到的文献（由 thesis_lit_search/save 写入）。
% 每条必须含 DOI 或 URL。引用格式遵循 GB/T 7714-2015（顺序编码制）。
`,
  })

  files.push({
    path: '02-文献/检索记录.md',
    content: `# 文献检索记录

${HEADER_NOTE}

> 每次检索留痕：哪个库、什么关键词、命中多少、筛掉哪些、为什么。
> 这是"零假文献"的审计证据。

| 日期 | 数据库 | 关键词 | 命中 | 收录 | 备注 |
|---|---|---|---|---|---|
| ${opts.date} | （待检索） | — | — | — | — |
`,
  })

  files.push({ path: '02-文献/笔记/.gitkeep', content: '' })

  // ---------------------------------------------------------------- 03-设计
  files.push({
    path: '03-设计/需求分析.md',
    content: `# 需求分析

${HEADER_NOTE}

> 规范见 \`thesis-eng-design\` 技能。功能需求编号 FR-x，非功能 NFR-x。

## 1 系统概述

<一句话：系统给谁用、解决什么问题>

## 2 功能需求

| 编号 | 功能 | 说明 | 优先级 |
|---|---|---|---|
| FR-1 | | | 高 |

## 3 非功能需求

| 编号 | 类别 | 要求 |
|---|---|---|
| NFR-1 | 性能 | |
| NFR-2 | 安全 | |
| NFR-3 | 易用性 | |

## 4 用例描述

<核心用例：参与者 → 操作 → 系统响应>
`,
  })

  files.push({
    path: '03-设计/系统设计.md',
    content: `# 系统设计

${HEADER_NOTE}

## 1 总体架构

<架构图：可用 Mermaid（flowchart/architecture）>

## 2 模块划分

| 模块 | 职责 | 对外接口 |
|---|---|---|

## 3 数据库设计

<ER 图 + 关键表结构>

## 4 接口设计

<API/接口列表：路径、方法、参数、返回>
`,
  })

  files.push({
    path: '03-设计/技术选型论证.md',
    content: `# 技术选型论证

${HEADER_NOTE}

> 答辩高频问题："为什么选这个技术？" 每个选型按下面模板论证并写入决定日志。

| 选型项 | 选择 | 理由 | 备选 | 弃用备选的原因 |
|---|---|---|---|---|
| 后端框架 | | | | |
| 前端 | | | | |
| 数据库 | | | | |
| 部署 | | | | |
`,
  })

  // ---------------------------------------------------------------- 04-实现
  files.push({
    path: '04-实现/.gitkeep',
    content: '',
  })

  // ---------------------------------------------------------- 05-实验测试
  files.push({
    path: '05-实验测试/测试计划.md',
    content: `# 测试计划

${HEADER_NOTE}

| 用例 ID | 对应需求 | 步骤 | 预期结果 |
|---|---|---|---|
| TC-1 | FR-1 | | |

> 红线：所有结果必须真实运行获得，截图/数据存入 结果/ 目录并注明复现步骤。
`,
  })

  files.push({ path: '05-实验测试/结果/.gitkeep', content: '' })

  // ---------------------------------------------------------------- 06-论文
  files.push({
    path: '06-论文/大纲.md',
    content: `# 论文大纲

${HEADER_NOTE}

七章标准结构（计算机类毕设通用；以学校模板为准）。字数目标为常见要求
（总计约 1.5-2 万字），最终以学校文件为准。

| 章 | 内容 | 字数目标 |
|---|---|---|
| 1 绪论 | 背景、意义、国内外现状、本文工作与组织结构 | 2000-2500 |
| 2 相关技术 | 用到的关键技术介绍（结合文献笔记） | 1500-2500 |
| 3 需求分析 | 功能/非功能需求、用例 | 1500-2000 |
| 4 系统设计 | 架构、模块、数据库、接口 | 2500-3500 |
| 5 系统实现 | 关键模块实现细节（结合真实代码） | 3000-4000 |
| 6 系统测试 | 测试环境、用例、真实结果与分析 | 2000-3000 |
| 7 总结与展望 | 工作总结、不足与改进方向 | 800-1200 |
`,
  })

  for (const [i, meta] of CHAPTER_META.entries()) {
    files.push({
      path: `06-论文/章节/${meta.file}.md`,
      content: chapterTemplate(i + 1, meta),
    })
  }

  files.push({ path: '06-论文/图表/.gitkeep', content: '' })
  files.push({
    path: '06-论文/assets/学校模板/README.md',
    content: `# 学校模板与规范

${HEADER_NOTE}

> 把学校发的所有规范文件放这里：论文模板（docx）、格式要求、字数要求、
> 引用规范、查重要求。\`thesis_build\` 与 \`thesis_check\` 以这里的文件为准。
> 尚未拿到时，构建工具会使用内置过渡模板并显式标注"非学校模板"。

获取渠道建议：教务处网站、学院通知、学长学姐。
`,
  })
  files.push({ path: '06-论文/产出/.gitkeep', content: '' })

  // ---------------------------------------------------------------- 07-答辩
  files.push({
    path: '07-答辩/PPT大纲.md',
    content: `# 答辩 PPT 大纲

${HEADER_NOTE}

> 标准 10-12 页，规范见 \`thesis-defense\` 技能。

1. 封面（课题/学生/导师）
2. 目录
3. 课题背景与意义
4. 国内外现状（1 页，图为主）
5. 需求分析（用例/功能点）
6. 系统总体设计（架构图）
7. 关键实现（2-3 页：核心模块 + 代码/界面截图）
8. 系统测试（真实数据图）
9. 总结与展望
10. 致谢/问答页
`,
  })

  files.push({
    path: '07-答辩/问答演练.md',
    content: `# 问答演练

${HEADER_NOTE}

> 预答辩问题库由 \`thesis_defense\` 工具根据论文与代码生成；
> 每次演练记录一问一答，重点练习"你的系统怎么实现的"。

（待演练）
`,
  })

  // ---------------------------------------------------------------- 08-合规
  files.push({
    path: '08-合规/自查报告.md',
    content: `# 提交前自查报告

${HEADER_NOTE}

> 关卡 **G4** 的产物。\`thesis_check\` 与 \`thesis_stylecheck\` 的输出汇总于此，
> 用户确认已阅读后 G4 方可标记通过。

## 1 引用检查

<来自 thesis_check：每条引用 ↔ refs.bib 双向一致；全部真实可查>

## 2 格式检查

<来自 thesis_check：模板/图表编号/字数/术语一致性>

## 3 查重前自查

<重复风险段落清单与降重动作>

## 4 AI 味自查

<来自 thesis_stylecheck：需人工改写段落清单与处理记录>

## 5 用户确认

- [ ] 我已阅读本报告并完成相应修改。
- 确认人：________ 日期：________
`,
  })

  files.push({ path: '08-合规/格式检查报告/.gitkeep', content: '' })
  files.push({ path: '08-合规/引用检查报告/.gitkeep', content: '' })

  return files
}

// ---------------------------------------------------------------------------
// 章节模板
// ---------------------------------------------------------------------------

export interface ChapterMeta {
  readonly file: string
  readonly title: string
  readonly outline: readonly string[]
  readonly words: string
  /** 该章专属的 G2 验收要点。 */
  readonly checklist: readonly string[]
}

export const CHAPTER_META: readonly ChapterMeta[] = [
  {
    file: '01-绪论',
    title: '绪论',
    words: '2000-2500',
    outline: ['1.1 研究背景与意义', '1.2 国内外研究现状', '1.3 本文主要工作', '1.4 论文组织结构'],
    checklist: ['背景→问题→意义的逻辑链完整', '研究现状按主题组织且每条引用真实', '本文工作与后文章节一一对应'],
  },
  {
    file: '02-相关技术',
    title: '相关技术',
    words: '1500-2500',
    outline: ['2.1 <核心技术一>', '2.2 <核心技术二>', '2.3 <核心技术三>', '2.4 本章小结'],
    checklist: ['只介绍本系统真正用到的技术', '每项技术结合文献笔记说明', '与第四章设计形成呼应（不是技术手册摘抄）'],
  },
  {
    file: '03-需求分析',
    title: '需求分析',
    words: '1500-2000',
    outline: ['3.1 系统概述', '3.2 功能需求', '3.3 非功能需求', '3.4 用例分析'],
    checklist: ['需求编号 FR/NFR 与 03-设计/需求分析.md 一致', '每条功能需求在第五章有对应实现、第六章有对应测试'],
  },
  {
    file: '04-系统设计',
    title: '系统设计',
    words: '2500-3500',
    outline: ['4.1 总体架构设计', '4.2 模块设计', '4.3 数据库设计', '4.4 接口设计', '4.5 本章小结'],
    checklist: ['有架构图且与真实代码一致', '每个模块职责单一、接口清晰', '技术选型有论证（引用技术选型论证.md）'],
  },
  {
    file: '05-系统实现',
    title: '系统实现',
    words: '3000-4000',
    outline: ['5.1 开发环境', '5.2 <模块一>实现', '5.3 <模块二>实现', '5.4 <模块三>实现', '5.5 本章小结'],
    checklist: ['代码片段来自真实代码（04-实现），可复现', '每张界面截图来自真实运行', '关键实现细节讲清"为什么这么写"'],
  },
  {
    file: '06-系统测试',
    title: '系统测试',
    words: '2000-3000',
    outline: ['6.1 测试环境', '6.2 测试用例设计', '6.3 测试结果与分析', '6.4 本章小结'],
    checklist: ['用例编号与测试计划一致', '结果全部真实（05-实验测试/结果）', '对失败用例有分析与修复记录'],
  },
  {
    file: '07-总结与展望',
    title: '总结与展望',
    words: '800-1200',
    outline: ['7.1 工作总结', '7.2 不足与展望'],
    checklist: ['总结与绪论"本文主要工作"呼应', '不足诚实、展望具体（不是空话）'],
  },
]

export function chapterTemplate(n: number, meta: ChapterMeta): string {  return `# 第 ${n} 章 ${meta.title}

> 字数目标：${meta.words} 字（以学校要求为准）
> 写作规范：\`thesis-writing\` 技能；引用规范：\`thesis-citation\` 技能
> 本章通过关卡 G2 验收后，用 \`thesis_progress\` 标记。

## 大纲

${meta.outline.map(x => `- ${x}`).join('\n')}

## 正文

（写作要求：基于真实素材——文献笔记、03-设计文档、04-实现代码、05-实验测试结果——逐段撰写；写完后执行 G2 验收）

## 本章 G2 验收清单

${meta.checklist.map(x => `- [ ] ${x}`).join('\n')}
- [ ] 用户已阅读本章并完成修改，书面确认验收
`
}

/** 章节文件列表（供工具与测试使用）。 */
export const CHAPTER_FILES: readonly string[] = CHAPTER_META.map(m => m.file)

/** 按文件名（带或不带 .md 后缀）查找章节元数据。 */
export function chapterMetaFor(file: string): { meta: ChapterMeta; chapterNo: number } | undefined {
  const name = file.endsWith('.md') ? file.slice(0, -3) : file
  const index = CHAPTER_META.findIndex(m => m.file === name)
  if (index === -1) return undefined
  return { meta: CHAPTER_META[index]!, chapterNo: index + 1 }
}

function cjkCount(text: string): number {
  return (text.match(/[\u4e00-\u9fff]/g) ?? []).length
}

/**
 * 章节"已撰写"判定（确定性）：
 * - 勾选过至少一项 G2 清单（- [x]），或
 * - 正文 CJK 字数比模板脚手架多 100 字以上（模板只含大纲与写作要求）。
 * 供 thesis_build / thesis_check / thesis_stylecheck 共用，
 * 避免把未动笔的脚手架当正文处理。
 */
export function isWrittenChapter(text: string, metaNo: number, meta: ChapterMeta): boolean {
  if (/^\s*- \[x\]/m.test(text)) return true
  return cjkCount(text) > cjkCount(chapterTemplate(metaNo, meta)) + 100
}
