# dsh-thesis 设计文档

**一句话**：让一个对流程不了解的本科生，把「学校模板 + 论文要求 + 实验数据 + 代码 + 参考文献」这堆材料，
在 AI 的带教下变成**一篇真实系统与真实数据背书、符合学校规范、经得起查重与答辩的论文**，
外加**一个能在答辩席上讲清自己系统的作者**。

---

## 1. 设计目标（五条可验收标准）

不是功能数量，而是五件能被检查的事：

1. **零假文献**：每条参考文献都来自真实学术检索，工具层强制（`thesis_lit_save` 只接受检索缓存 id）。
2. **零假成果**：每个实验数据、截图都来自真实运行；原创性自查明文禁止为降重改动数据与结论。
3. **人是作者**：关键决策有用户书面拍板（G1-G4 闸门 + 决定日志），答辩能讲清「为什么」。
4. **规范驱动**：格式/引用/字数/模板以学校真实文件为准；缺失时显式标注「通用过渡模板」。
5. **真的能跑**：所有工具可执行、可失败、有测试；文档描述与实现一一对应。

**唯一的领域模型**：材料 → 要求 → 九阶段 → 论文与答辩。对外工具只有两个命名空间，
`thesis_*`（操作论文工作区）与 `fact_*`（跨会话仍成立的事实），答辩层的代码演练是 `defense_code_*`。

**最重要的一条设计取舍**：**先追问、后动手**。写错方向的代价是整章重写，而问清楚只要十分钟。
`thesis_intake` 把模糊口述收敛成《意图规格》（`00-管理/意图规格.md`），
后续写作、检查、原创性自查、幻灯、答辩**只依据这份文件**。

---

## 2. 总体架构

```
┌──────────────────────────────────────────────────────────────────────┐
│ DSH（Web / CLI）：自然语言 + /thesis-* 命令                            │
├──────────────────────────────────────────────────────────────────────┤
│ 单一插件 dsh-thesis（Cordis 插件，纯 TypeScript，一行 cordis.patch.yml）│
│                                                                       │
│  入口层    ingest/（材料摄取）      intake/（逐题追问 → 意图规格）      │
│  流水线    paper/（台账/关卡/文献/评审/检查/docx/答辩素材）             │
│  合规层    dedup/（本地相似度 + 改写处方 + 复测）                       │
│  答辩层    ppt/（Marp Markdown + 外部转换器）  codewalk/（代码演练）    │
│  横切层    memory/（跨会话事实 + 相关时自动回灌）                       │
│  闸门层    gates/（写作意图闸门 + 不可逆操作闸门）  intake/gate（规格闸门）│
│  共享层    shared/（工具定义器、文本与文件系统错误工具、子进程助手）      │
├──────────────────────────────────────────────────────────────────────┤
│ 技能包 skills/**（11 个方法论技能，`thesis_init` 复制到论文仓库         │
│ .dsh/skills/，项目级 rank 100 最高优先级，随论文 git 版本化）           │
├──────────────────────────────────────────────────────────────────────┤
│ 论文工作区（git 仓库，唯一数据真相）：00-管理 … 08-合规 + 意图规格       │
└──────────────────────────────────────────────────────────────────────┘
```

### 2.1 目录与模块职责

| 路径 | 职责 | 对外表面 |
|---|---|---|
| `src/index.ts` | 唯一装配层：`apply()` 调各模块 register，最后装闸门 | `name` / `inject` / `Config` / `apply` |
| `src/config.ts` | 统一配置 schema + 默认值单一来源 + `resolveConfig` | `Config` / `PAPER_DEFAULTS` |
| `src/commands.ts` | 斜杠命令的聚合层（`/thesis-defense` 同时覆盖幻灯与代码演练） | `registerDefenseCommand` |
| `src/shared/**` | 工具胶水、`definePaperTool`、文本与 fs 错误工具、`spawnCommand` | `definePaperTool` 等 |
| `src/gates/**` | 写作意图闸门（`agent/pre-step`）+ 不可逆操作闸门（`tools/pre-execute`） | `installWritingGate` / `installDangerousGate` |
| `src/ingest/**` | ZIP/OOXML/PDF 解析 → 文本；源码目录 → **代码结构摘要**（不贴正文） | `registerIngest` |
| `src/intake/**` | 问题库 + 状态机 + 意图规格渲染 + 规格闸门 | `registerIntake` |
| `src/paper/**` | 论文流水线（纯逻辑 + 工具 + 命令） | `registerPaper` |
| `src/dedup/**` | 归一化 + 相似度 + 改写处方 + 报告 | `registerDedup` |
| `src/ppt/**` | 幻灯计划 + Marp 渲染 + 转换器探测 | `registerPpt` |
| `src/codewalk/**` | 代码演练：阶段状态机 + 验证门 + 可评分追问 | `registerCodewalk` |
| `src/memory/**` | SQLite 跨会话事实 + 相关时回灌 | `registerFacts` / `installFactRecall` |

### 2.2 分层规则（全仓库唯一的硬性架构约束）

> **纯逻辑不依赖宿主，宿主胶水不含业务判断。**

每个模块都拆成「零宿主依赖的纯函数层」（可 `node --test` 直跑）+「很薄的 register 层」。
收益是可测性与可替换性：记忆的 SQL 语义、原创性度量的相似度、幻灯渲染、追问排序、
代码演练的状态机，全都能在没有 DSH 运行时的环境里被完整验证。

第二条规则：**面向学生的概念不来自模块名**。模块可以叫 `memory/`，
但学生看到的说法是「跨会话记住学校规范」，而不是某个以「记忆」命名、需要学生自己调用的工具
（对外工具是 `fact_*`：`fact_search` / `fact_remember` / `fact_context`）。

---

## 3. 对外表面契约

### 3.1 工具（21 个，三个命名空间）

**`thesis_*`：操作论文工作区里的东西**

| 工具 | 学生视角的一句话 |
|---|---|
| `thesis_ingest` | 把我的材料读进来（docx/xlsx/pptx/pdf/csv/代码 → 文本与结构摘要 + 材料清单） |
| `thesis_intake` | 一次问我一个要求问题，问完写成《意图规格》 |
| `thesis_init` | 建论文工作区（目录、台账、决定日志、七章模板、技能包） |
| `thesis_progress` | 看进度 / 过闸门 G1-G4 |
| `thesis_decide` | 记下我为什么这么定（答辩要用的证据） |
| `thesis_lit_search` / `thesis_lit_save` / `thesis_lit_note` | 真实检索文献 / 收录进 refs.bib / 生成阅读笔记 |
| `thesis_review` | 单章六项评审（字数、大纲、引用、图表编号、未完成标记、G2 清单） |
| `thesis_check` | 全文五项检查（引用双向一致、字数、编号、术语、学校模板探测） |
| `thesis_stylecheck` | 写作风格自查（六条启发式，附行号与改写建议） |
| `thesis_build` | 出论文 `.docx`（优先 pandoc + 学校模板，无 pandoc 用内置零依赖生成器） |
| `thesis_originality` | 原创性自查：scan 定位高风险段落 → verify 复测降幅 → report 汇总 |

**`thesis_*` 的答辩部分**

| 工具 | 学生视角的一句话 |
|---|---|
| `thesis_defense` | 提取答辩素材 + 六类必问问题库（附证据锚点） |
| `thesis_slides` | 生成 10-12 页 Marp 幻灯，并可选转换为 `.pptx` |

**`defense_code_*`：代码演练（答辩层）**

| 工具 | 学生视角的一句话 |
|---|---|
| `defense_code_status` | 我的系统我讲得清吗（阶段、里程碑、验证门、未通过的问题） |
| `defense_code_next` | 下一个该弄懂的模块（含 todo 与评分要点） |
| `defense_code_update` | 登记/推进/评分/重试（每次改动立即落盘） |

**`fact_*`：跨会话事实**

| 工具 | 学生视角的一句话 |
|---|---|
| `fact_search` / `fact_remember` / `fact_context` | 上次记下的学校规范还在吗 / 记住这条稳定事实 / 把这个课题已知事实拉回来 |

### 3.2 命令（9 个）

`/thesis-status` `/thesis-decide` `/thesis-lit` `/thesis-check` `/thesis-build`
`/thesis-ingest` `/thesis-intake` `/thesis-originality` `/thesis-defense`

命令名必须匹配 DSH 的 `/^[a-z][a-z0-9_-]*$/`；`/thesis-defense` 的子命令按侧分派：
幻灯侧 `prepare`（= outline）/ `convert` / `check` / `guide`，代码演练侧 `new` / `status` / `check`。

---

## 4. 配置契约

所有字段都有出厂默认值，`PAPER_DEFAULTS` 是 schema `.default()` 与代码侧回退的**单一来源**
（绝不让「缺配置」退化成「静默关闸门」）。配置面只用论文领域词汇：

```ts
export interface PaperConfig extends GateOptions {
  workspace?: string                 // 缺省从会话 cwd 向上探测 00-管理/进度台账.md
  memoryPath?: string                // 缺省 $DSH_HOME/paper-memory.db
  ingest?: Partial<IngestOptions>
  intake?: Partial<IntakeOptions>
  similarity?: Partial<SimilarityOptions>
  stylecheck?: Partial<StylecheckOptions>
  ppt?: Partial<PptOptions>
  defense?: Partial<DefenseOptions>
  codeWalkthrough?: Partial<CodeWalkthroughOptions>
  recall?: Partial<RecallOptions>
}
```

`GateOptions` 管两个闸门：`writingGate`（要求没立稳时拦截「开始写」）、
`destructiveGate`（不可逆命令前提请人类拍板），以及它们各自的模式列表与 `maxQuestions`。

**`workspace` 的语义是确定的**：配置了就只认它；该路径下没有台账时**明确报错**，
绝不悄悄退回到 cwd 探测去写到别的目录。

---

## 5. 领域闭环：要求与被约束的产出物必须可达

追问问题声明它影响哪些产出物：`affects: IntakeAffect[]`。这不是描述性文字，
而是一条**可达性契约**（`AFFECT_TOOLS` 映射）：

```ts
export type IntakeAffect =
  | '格式检查'    // → thesis_check
  | '引用规范'    // → thesis_lit_* · thesis_check
  | '字数分配'    // → thesis_review · thesis_check
  | '写作规范'    // → thesis_stylecheck
  | '原创性'      // → thesis_originality
  | '答案PPT'     // → thesis_slides
  | '答辩问答'    // → thesis_defense · defense_code_*
  | '文献检索'    // → thesis_lit_search
```

约束：**每个 `IntakeAffect` 必须至少被一个真实工具兑现**。
新增问题若声明了一个没有工具兑现的产出物，测试立刻变红——
这消灭了「问了一堆用不上的要求」这类退化。

---

## 6. 关键设计决策（ADR）

### ADR-1 单一包、单一插件行

`dsh plugin add` 一次装完，一个 `Config`，一套技能，模块间共享上下文（intake 写规格、写作读规格、
原创性自查读章节、幻灯读答辩素材）。代价是包变大；用「目录即模块 + 无跨模块反向依赖」控制耦合。
`/thesis-defense` 需要同时覆盖幻灯与代码演练，因此它的注册放在装配层（`src/commands.ts`），
而不是让 `ppt/` 与 `codewalk/` 互相依赖。

### ADR-2 材料先追问、后动手

`thesis_intake` 的硬约束：**一次只返回一个问题**、每问必带「为什么问 / 影响哪个产出 / 合格答案形态」、
材料里能读出来的不重复问、`required` 齐了才允许 `done`。

### ADR-3 零第三方运行时依赖（含 Office 解析）

- ZIP 读取器自实现（EOCD + 中央目录 + STORE/DEFLATE，DEFLATE 用内置 `node:zlib`）；
- docx/xlsx/pptx 走 OOXML 文本抽取，不引入 mammoth/xlsx/jszip；
- PDF 用内置能力**尽力而为**，抽不出来就诚实报错；
- 记忆用内置 `node:sqlite`；
- 唯一非内置依赖是 `@deepseek-ai/schemastery`（Config schema 的 `z<Config>` 双重语义无法伪造）。

收益：离线可构建、可评审、供应链风险为零、插件体积小。

### ADR-4 代码走「结构摘要」而不是「正文倒出」

用户材料里的代码若按文本摄取，一个上万行的仓库会挤爆上下文且对写作无益。
`src/ingest/code.ts` 只提取**结构信号**：语言、文件/行数/代码行/注释行、顶层声明与行号、
依赖清单推断的技术栈指纹、以及被跳过的大文件清单。产物是 `00-管理/材料/<目录>-代码结构.md`，
直接服务「系统实现」章的骨架、工作量证据与答辩索引。

### ADR-5 只在运行时依赖宿主的两处能力

运行期 import 宿主包只有两处：`schemastery`（schema）与 `dsh-tools` 的 `defineTool`
（离线退回 `src/shared/define-tool.ts` 的等价实现）。其余宿主能力（`ctx.fs`/`ctx.tools`/
`ctx.commands`/`ctx.on`/`ctx.provide`/`ctx.effect`）都经 `ctx` 注入。
**理由**：把编译期的类型耦合压到最小，让仓库在只有 `typescript` 的环境里 `tsc` 全绿、`node --test` 全绿。

### ADR-6 原创性自查只做「诚实度量 + 改写处方」

本地、确定性、可复现（shingle 指纹 + 倒排剪枝 + 最长公共片段定位），报告写明估算口径；
**不接入**知网/维普等收费系统；处方明确「必须保留」：数字、单位、术语、公式、引用标记、代码标识符——
为降重改数据是学术不端。与 `thesis_stylecheck` 同源：两者同时命中的段落优先**整段重写**。

### ADR-7 答辩幻灯以 Markdown 为唯一真相

`07-答辩/PPT.md`（Marp 兼容）可 git diff、可复用、不依赖 Office；`.pptx` 是派生产物。
转换链路探测外部引擎（marp → npx marp-cli → pandoc）→ 成功则产出 →
失败/缺失则写「转换说明」给出可复制命令与兜底路径，**绝不假装成功**
（退出码 0 但产物 0 字节也判失败）。

### ADR-8 跨会话事实用全局库 + key 命名空间

装配发生在进程启动、拿不到会话 cwd；而事实里跨课题复用的内容（写作风格偏好、导师沟通习惯、
学校通用规范）本就该跨项目活着。约定 `user.*` / `school.*` / `thesis.<slug>.*`，
技能明文规定「不要把进度与一次性实验数字写进事实」。

### ADR-9 技能随插件发布并复制进论文仓库

项目级技能目录 `<论文仓库>/.dsh/skills`（rank 100）优先级高于用户级（400）；
`thesis_init` 把 `skills/**` 复制过去，使方法论与论文同版本、同 git 历史、可离线迁移。
技能名必须等于目录名、frontmatter 不得带 BOM（带 BOM 时 DSH 的解析返回 undefined，技能被静默忽略）。

### ADR-10 目录结构只在 paper 模块内成形

论文工作区的九阶段目录（`00-管理` … `08-合规`）由 `paper/lib/layout.ts` 唯一产生；
其它模块只往既有目录写产物（`00-管理/材料清单.md`、`08-合规/降重报告.md`、`07-答辩/PPT.md`），
**不新增顶层阶段目录**。

### ADR-11 读不出来 ≠ 不存在

工作区里的追问答案、进度台账、文献库、检索记录、决定日志都是学生的资产，且不可再生。
所有读路径必须区分「确认不存在（ENOENT / FS_NOT_FOUND）」与「读失败」：
前者可回退到默认值，后者**必须抛错并保持原文件不动**。
把读失败当成「还没建过」然后用默认值覆盖，是本插件最严重的一类缺陷——
用户连「发生了什么」都不会知道。相关工具集中在 `src/shared/fs-errors.ts`。

### ADR-12 子进程的成功判据是「真的成功了」

`spawnSync` 在子进程从未启动（如受限环境 `EPERM`）、被信号杀死或被 timeout 掐断时
返回 `status: null`。因此成功判据只能是 `status === 0`；并且默认用 `stdio: 'ignore'`
（某些受限环境里管道 stdio 直接被拒），需要输出时才 `capture`。
统一实现在 `src/shared/spawn.ts`，并给 pandoc 之类的调用配了超时。

---

## 7. 数据与产物

| 产物 | 位置 | 产生者 |
|---|---|---|
| 意图规格（唯一真相） | `00-管理/意图规格.md` | `thesis_intake` |
| 材料清单 + 逐文件摘要 | `00-管理/材料清单.md`、`00-管理/材料/*.md` | `thesis_ingest` |
| 进度台账 / 决定日志 / 时间线 | `00-管理/` | `thesis_init` / `thesis_progress` / `thesis_decide` |
| 文献库与检索审计 | `02-文献/refs.bib`、`检索记录.md`、`笔记/` | `thesis_lit_*` |
| 章节与产出 | `06-论文/章节/*.md`、`产出/论文.docx` | 写作 + `thesis_build` |
| 合规报告 | `08-合规/`（引用/格式/AI 味/降重/复测） | `thesis_check` / `thesis_stylecheck` / `thesis_originality` |
| 答辩材料 | `07-答辩/答辩素材.md`、`预答辩问题库.md`、`PPT.md` | `thesis_defense` / `thesis_slides` |
| 插件状态 | `<cwd>/.paper/`（追问状态、代码演练状态） | `intake/` / `codewalk/` |
| 跨会话事实 | `$DSH_HOME/paper-memory.db` | `fact_*` |

---

## 8. 九阶段流水线与人工关卡

| 阶段 | 产出物 | 验收标准 | 人工关卡 |
|---|---|---|---|
| 1 选题 | 选题确认书 | 课题明确、工作量合理、答辩友好 | **G1** |
| 2 开题 | 开题报告 + 任务书 | 导师认可；结构与规范达标 | **G3** |
| 3 文献调研 | 文献库 + 笔记 + 综述素材 | 15-30 篇真实文献；每篇有笔记 | — |
| 4 系统设计 | 需求/设计/选型文档 | 方案可落地；选型有论证 | — |
| 5 系统实现 | 可运行系统 + git 提交 | 功能真实可跑 | — |
| 6 系统测试 | 测试报告 + 真实结果 | 结果可复现；零伪造 | — |
| 7 论文撰写 | 七章正文 | 逐章人工验收 | **G2**（×7 章） |
| 8 定稿与合规 | 论文.docx + 检查报告 | 格式/引用/自查全部通过 | **G4** |
| 9 答辩 | 幻灯 + 演练记录 | 能讲清设计与实现 | — |

关卡由 `thesis_progress` 在工具层强制：阶段入口关卡未通过时该阶段任务拒绝推进；
通过关卡前其关联任务必须先完成。**闸门不是提示语，是拒绝。**

另有两道横切闸门：写作意图闸门（`agent/pre-step`，用户要开写但要求没谈清时注入追问指令，
用户说「直接写」即放行）与不可逆操作闸门（`tools/pre-execute`，破坏性命令以 ask 决策提请拍板，
是唯一不可被提示词绕过的一道）。

---

## 9. 质量与测试策略（证据分层）

| 层 | 命令 | 内容 |
|---|---|---|
| 纯逻辑与契约 | `npm run test:sandbox` | 430 条：相似度、归一化、处方、问题排序、状态机、幻灯渲染、OOXML/PDF 解析、记忆 SQL、代码结构摘要；装配契约（21 工具 / 9 命令 / 2 服务 / 4 类监听）；`definePaperTool` 的 DSL→JSON Schema 编译 |
| **真实场景端到端** | `npm run test:e2e` | 65 条断言，见 §9.1 |
| **真实宿主** | `npm run test:host` | 24 项：真实 cordis + dsh-tools 装配、工具 schema 被真实注册表接受、真实执行工具、宿主拒绝缺参、**闸门在真实 waterfall 上真的注入**、卸载后工具注销 |
| **真实引擎装载** | `npm run test:host-load` | 11 项：真实 `dsh` 引擎解析并校验本插件 |
| 对外表面审计 | `npm run audit` | 工具/命令/技能契约一致 + 技能命名/BOM 检查，见 §9.3 |
| 真实网络（可选） | `npm run test:net` | 真实学术 API 检索 → 收录 → 笔记 |

`npm run verify` = build + typecheck + 单元/契约 + 审计 + 端到端，是主线不变的守门命令。

### 9.1 真实场景端到端基准

夹具 `tests/e2e/fixtures/jiangzhou-thesis/`（一所虚构学校的真实形态材料）：

| 夹具 | 作用 |
|---|---|
| `学校论文规范.md` | 字数/查重阈值/引用格式/AI 政策/答辩形式 → 驱动追问与格式检查 |
| `实验数据-检索性能.csv` | 真实运行数据（20 次）→ 驱动第六、七章与图表编号检查 |
| `系统源码摘要.md` | 代码结构 → 驱动第五章与答辩素材 |
| `导师要求.txt` | 导师口径 → 驱动意图规格与决定日志 |

一条命令、**全程离线**跑完 11 环并逐环断言：建库 → 摄取（清单+摘要）→ 追问（含「必答未齐拒绝 done」
负路径）→ 决定留痕 → 七章写作与逐章评审 → G1/G2 闸门（含负路径）→ 全文检查 →
写作风格自查 → docx 构建 → 原创性自查（scan → verify）→ 幻灯（页数/时长窗口）→ 答辩素材。

其中 docx 的校验是**独立 ZIP 解析**：自读中央目录、`inflateRawSync` 解出 `word/document.xml`，
按 UTF-8 断言真实正文与「不含待补/TODO 残留」——而不是只看文件签名。

### 9.2 失败路径与鲁棒性

负路径是必测项，且**最严重的缺陷类型是「静默假装成功」**：
转换器缺失却报成功、抽取失败却返回空正文、读失败却用默认值覆盖。
`tests/robustness.test.ts` 专测数据安全与边界，断言一律成对：
「工具抛错」+「原文件零改动（或零写盘）」。

### 9.3 审计为什么必须有

对外名字（工具名、命令名、技能名）是**契约**：学生与宿主都按名字调用，改名而不改文档
就是文档骗人，改名而不改测试就是契约失守。这类漂移只靠人工看必然漏，
故 `scripts/audit-surface.mjs` 把它们固定成断言：**注册集必须恰好等于契约集**，
多一个少一个都失败；技能 frontmatter 的 `name` 必须等于目录名（DSH 按目录名发现技能）；
`SKILL.md` 不得带 BOM（带 BOM 时宿主解析 frontmatter 返回 undefined，**整个技能被静默忽略**——
文件明明在、技能却不存在，是最难排查的一类故障）。

**脚本会自己腐坏，所以它有测试**：审计脚本自身一旦写错（正则不匹配、路径算错、
例外开得太宽），就会给出虚假的绿色。因此它的每条规则要么能被现有测试独立覆盖
（装配契约由 `tests/composition.test.ts` 断言），要么口径收得足够窄、宁少勿假。
审计脚本不再承担「零前身残留」这类**过渡期脚手架**职责：脚手架是给重构过程用的，
重构结束后继续留着，只会留下一条永远为假的例外和一份没人再读的词表。

---

## 10. 已知边界（诚实清单）

1. **PDF 抽取是尽力而为**：扫描版（无文本层）、对象流/加密 PDF 可能抽不到文字；
   工具返回 `ok:false` + 原因，绝不编造内容；低抽取率会带 `lowConfidence` 标记。
2. **旧二进制 Office 格式（.doc/.xls/.ppt）不支持**，明确提示另存为新格式。
3. **查重不接收费系统**：报告的重复率是本地估算，与学校检测结果不可等同；口径与参数写进报告。
4. **幻灯依赖外部转换器**：本机无 marp/pandoc 时只能拿到 Markdown + 转换指引（幻灯文字已是最终稿）。
5. **代码演练内置语言矩阵只覆盖 Go/TS/Python/Rust**，其余语言需在配置里补 `gates`。
6. **子进程不可取消**：pandoc/marp/git 走 `spawnSync`，有超时上限，但 `exec.signal` 不进入子进程。
7. **受限环境下管道 stdio 被拒**：某些沙箱里 `stdio: 'pipe'` 会 `EPERM`，故默认 `stdio: 'ignore'`。
8. **宿主契约以本地 shim 声明**：真实签名核对见 [docs/host-api.md](./docs/host-api.md)，
   运行时行为由端到端基准与真实宿主冒烟兜底。
9. **真实 `dsh` 引擎的装载验证需要写 `$DSH_HOME/profiles/<name>/cordis.yml`**（引擎在
   `--dump-config` 前就会写它）。受限沙箱下该写入会被拒，`npm run test:host-load` 因此需要放宽文件权限；
   `npm run test:host`（真实 cordis，不碰 profile）不需要。
10. **意图规格是「一次到位」的努力而非保证**：已知的返工源会被问完，未知风险仍会在阶段推进中暴露，
    此时应回到 `thesis_intake` 补问并把答案写回规格。

---

## 11. 反目标（明确不做）

1. **不做多插件拆分**——单一插件 = 一次安装、一个配置、一套技能、模块间共享上下文。
2. **不引入运行时第三方依赖**——离线可构建、可评审、供应链风险为零。
3. **不自研 pptx 生成器**——Markdown 为唯一真相，转换交给外部引擎，缺失时给可执行指引。
4. **不接收费查重系统**——只做本地确定性度量，口径写进报告。
5. **不保留旧工具名别名**——别名会让两套叙事长期共存，比改名本身更伤人。
