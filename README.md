# dsh-thesis

**把一堆材料变成一篇经得起查重与答辩的论文，和一个讲得清自己系统的你。**

`dsh-thesis` 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的单一插件。
给它学校模板、论文要求、实验数据、代码和参考文献，它会**先追问、再动手**——
把要求问成一份可证伪的《意图规格》，然后按九个阶段推进：

**选题 → 开题 → 文献 → 设计 → 实现 → 测试 → 论文 → 合规 → 答辩**

全程留痕（进度台账 + 决定日志 + 检索记录 + 检查报告），每一步都要你拍板。

纯 TypeScript，零运行时第三方依赖（唯一的 devDependency 是 TypeScript 本身）。

> **立场**：插件对外只呈现**一个领域模型——大学生写论文**。
> 学生的工具清单里只有两个命名空间：`thesis_*`（操作论文工作区里的东西）与
> `fact_*`（跨会话仍然成立的事实：学校规范、导师要求、你的写作偏好）。
> 答辩层的代码演练用 `defense_code_*`。没有第四套命名。

---

## 安装

```bash
# 从 npm 安装（DSH 的插件安装会转发给 pnpm，机器上需要 pnpm）
dsh plugin --profile web add dsh-thesis

# 重启 dsh 后确认装上了 —— 应能看到 thesis_* / fact_* / defense_code_* 三个命名空间的工具
```

**从源码安装**（想改代码、或本机没有 pnpm）：

```bash
git clone https://github.com/Paloma966/dsh-thesis.git && cd dsh-thesis
npm install && npm run build                  # 插件必须发布编译后的 JS，DSH 没有 TS 加载器
dsh plugin --profile web add "$PWD"           # 需要 pnpm

# 没有 pnpm 时的兜底：建 profile 联接 + 打印要粘贴的补丁片段，然后重启 dsh
node scripts/install-into-profile.mjs --profile web
```

卸载：`dsh plugin --profile web remove dsh-thesis`（兜底方式安装的用 `install-into-profile.mjs --remove`）。

---

## 30 秒上手

装好并重启 dsh 后，在对话里说：

```
这是我的论文材料，帮我做毕业设计
```

然后把学校模板、要求文档、实验数据、代码、参考文献丢进工作区（或告诉它绝对路径）。
它会：`thesis_ingest` 读材料 → `thesis_intake` **一次问你一个问题** → 写 `00-管理/意图规格.md`
→ 建工作区（`thesis_init`）→ 按阶段推进。

没有材料也能用：直接说「我要做毕业设计，还没定题」→ 走选题工作坊。

> **注意工作区位置**：多数工具从会话的工作目录向上探测 `00-管理/进度台账.md` 来定位论文工作区。
> 所以**把会话开在论文目录里**最省事；也可以用配置显式指定：
> `config: { workspace: /path/to/你的论文 }`（路径写错会直接报错，不会写到别处）。

---

## 它怎么工作

```
              你的材料（docx / xlsx / pptx / pdf / md / csv / 代码 / 文献）
                                  │
                    thesis_ingest │ 读成纯文本 + 材料清单
                                  ▼
    ┌──────────────────────────────────────────────────────────┐
    │ thesis_intake：逐题追问（一次只问一个问题）                │
    │ 每问都带：为什么问 · 影响哪个产出 · 合格答案长什么样        │
    │ 材料里已能读出来的一律不问；答不全的显式列为阻塞项          │
    └──────────────────────────────────────────────────────────┘
                                  │
                    00-管理/意图规格.md（唯一真相）
                                  ▼
    ┌────────── 九阶段流水线（G1-G4 人工关卡不可跳） ──────────┐
    │ 选题 → 开题 → 文献 → 设计 → 实现 → 测试 → 论文 → 合规 → 答辩 │
    │ 零假文献（只认真实检索）· 零假数据（只认真实运行）           │
    └──────────────────────────────────────────────────────────┘
                                  │
        ┌──────────────┬──────────┴──────────┬──────────────┐
        ▼              ▼                     ▼              ▼
   论文.docx      答辩幻灯 PPT.md       原创性报告 + 复测   跨会话事实
  (内置零依赖   (Marp 兼容，可         (本地度量，        (换个会话不用
   生成器/pandoc) marp/pandoc → pptx)   不接收费系统)      重讲学校规范)
```

**为什么先追问**：写错方向的代价是整章重写，而问清楚只要十分钟。这是本插件与「AI 直接生成论文」的根本区别。

**而且它不靠自觉**：说「帮我写第三章」时，如果意图规格还没立全（缺学校模板/字数/查重阈值/时间线），
`agent/pre-step` 的写作意图闸门会注入一条指令**强制模型先去追问**；规格就绪后闸门自动安静；
想跳过就说「直接写」（插件会要求它列出采用的假设）。

---

## 工具全集（21 个）

### 论文工作区（`thesis_*`）

| 工具 | 作用 |
|---|---|
| `thesis_ingest` | 摄取材料：`.docx`/`.xlsx`/`.pptx`/`.pdf`/`.md`/`.csv`/`.bib`/`.html` → 文本摘要；**源码目录 → 代码结构摘要**（文件/行数/声明/技术栈指纹，不贴源码正文）；写 `00-管理/材料清单.md` 与逐文件摘要。旧格式 `.doc/.xls/.ppt` 会明确提示另存为新格式 |
| `thesis_intake` | 逐题追问状态机：`start`/`ask`/`answer`/`skip`/`status`/`spec`/`done` → 落盘 `00-管理/意图规格.md`（断点续问，永不丢答案） |
| `thesis_init` | 建论文工作区：九阶段目录、台账、决定日志、时间线、七章模板、文献库骨架、技能包 → `.dsh/skills/`，可选 git 首提交 |
| `thesis_progress` | 台账读写 + **G1-G4 闸门**（`report`/`update`/`gate`）：未过 G1 不许推进阶段、未过 G2 不许验收章节 |
| `thesis_decide` | 追加决定日志（内容/理由/备选）——答辩「为什么这么做」的答案库 |
| `thesis_lit_search` | 真实检索：Semantic Scholar → DBLP → arXiv → Crossref 失败降级；结果带真实 DOI/URL 并缓存留痕 |
| `thesis_lit_save` | 把检索到的文献（按缓存 id）收录进 `02-文献/refs.bib`；DOI 去重；**不接受缓存外的 id**（零假文献机制） |
| `thesis_lit_note` | 生成文献阅读笔记骨架（五节模板，摘要自动填入） |
| `thesis_review` | 单章确定性评审六项：字数区间、大纲齐全、引用对应、图表编号、未完成标记、G2 清单 |
| `thesis_check` | 全文五项检查：引用双向一致、每章字数、图表编号、术语先定义后使用、学校模板探测 |
| `thesis_build` | 出 `论文.docx`：优先 pandoc + 学校模板；无 pandoc 用**内置零依赖** docx 生成器（自实现 ZIP/CRC32/WordprocessingML） |
| `thesis_stylecheck` | 写作风格自查六条启发式（套话/空洞结论/自我暴露/翻译腔/句式单一/无锚点），附行号与改写建议 |

### 合规（原创性）

| 工具 | 作用 |
|---|---|
| `thesis_originality` | `scan` 找高风险段落（行号 + 命中来源 + 改写处方）→ 改完 `verify` 复测降幅 → `report` 汇总（可回填学校检测结果）。**本地确定性估算，不接知网/维普** |

### 答辩

| 工具 | 作用 |
|---|---|
| `thesis_defense` | 提取答辩素材 + 六类必问问题库（实现细节/技术选型/需求背景/工作量/数据可信/不足展望），附证据锚点 |
| `thesis_slides` | `outline` 生成 10-12 页 Marp 兼容 `07-答辩/PPT.md`（含讲稿与证据锚点）→ `check` 六项检查 → `convert` 用 marp/pandoc 出 pptx；没有转换器就给出可直接复制的命令与兜底方案 |
| `defense_code_status` / `defense_code_next` / `defense_code_update` | **代码演练**：把（常常是 AI 写的）系统拆成讲得清的模块，用真实验证门逐个走通，并用可评分的追问确认你在答辩席上讲得出实现细节与取舍 |

### 跨会话事实（`fact_*`）

| 工具 | 作用 |
|---|---|
| `fact_search` / `fact_remember` / `fact_context` | SQLite 事实库（默认 `$DSH_HOME/paper-memory.db`）：记住学校规范、导师要求、你的写作偏好。**而且不只被动查询**——你说的话与已确认事实相关时（词面重叠），插件自动把相关条目作为卡片放回上下文（最多 4 条/600 字符，事实没变就不重复注入） |

### 斜杠命令（9 个）

`/thesis-status` `/thesis-decide` `/thesis-lit` `/thesis-check` `/thesis-build`
`/thesis-ingest` `/thesis-intake` `/thesis-originality` `/thesis-defense`

---

## 技能包（方法论，随插件发布）

| 技能 | 触发时机 |
|---|---|
| `thesis-pipeline` | 每次会话开始（阶段、关卡、工具地图） |
| `thesis-opener` | 选题、开题报告、G1/G3 |
| `thesis-literature` | 文献检索与综述 |
| `thesis-eng-design` | 需求/设计/实现/测试规范 |
| `thesis-writing` | 写作规范与去 AI 味规则 |
| `thesis-citation` | GB/T 7714-2015 著录 |
| `thesis-defense` | 答辩准备与幻灯链路 |
| `code-walkthrough` | 答辩前把系统讲清（代码演练） |
| `paper-intake` | 材料到手后的追问方法论 |
| `paper-dedup` | 原创性自查的诚实做法（什么能改、什么绝不能改） |
| `thesis-inquiry` | 写作要求/导师口径模糊时的对抗式追问 |

`thesis_init` 会把整套技能复制进论文仓库 `.dsh/skills/`（项目级 rank 100，优先级最高），
所以技能随论文一起 git 版本化、换机器不丢。

---

## 配置

所有字段都有默认值；在 profile 的 `cordis.patch.yml` 里覆盖：

```yaml
- id: paper
  name: dsh-thesis
  config:
    workspace: /path/to/thesis            # 缺省从会话 cwd 向上探测 00-管理/进度台账.md
    memoryPath: /path/to/paper-memory.db  # 缺省 $DSH_HOME/paper-memory.db
    ingest:     { maxBytes: 33554432, maxChars: 60000 }
    intake:     { maxQuestions: 12, specRel: '00-管理/意图规格.md' }
    similarity: { shingle: 4, threshold: 0.3, minChars: 30 }      # 原创性自查度量
    stylecheck: { reportRel: '08-合规/AI味自查报告.md', maxParagraphChars: 260 }
    ppt:        { engine: auto, theme: default, timeoutMs: 120000 }  # auto|marp|pandoc|none
    defense:    { materialsRel: '07-答辩/答辩素材.md', defaultPages: 11 }
    codeWalkthrough: { stateDir: '.paper', gates: { go: { build: [go, build, ./...] } } }
    recall:     { maxEntries: 4, maxChars: 600, minKeywordLength: 2 }
    # 闸门
    writingGate: true          # 要求没立稳时拦截「开始写」
    destructiveGate: true      # 不可逆命令前提请拍板
    maxQuestions: 3
```

`workspace` **真的生效**：配置了就只认它，且台账不存在时会明确报错——绝不悄悄退回到 cwd 探测去写到别的目录。

---

## 红线（写在护栏里，不是写在文档里）

1. **零假文献**：正文引用只能来自 `thesis_lit_search` 的真实检索缓存；`thesis_lit_save` 拒绝缓存外的 id；`thesis_check` 复核双向一致。
2. **零假数据**：实验数据、截图、运行结果必须来自真实运行。工具与技能都不支持伪造，`thesis_originality` 明确禁止为降重改动数据与结论。
3. **人是作者**：G1-G4 关卡由 `thesis_progress` 强制，未过闸门不许推进；决定必须由用户拍板。
4. **规范以学校文件为准**：学校模板缺失时，用内置过渡模板并**显式标注"非学校模板"**，绝不假装合规。
5. **降重不是洗稿**：本插件不接收费查重系统，报告里的重复率是**本地估算**，与学校结果不可等同；用户自行送检后可回填对照。
6. **不静默销毁数据**：读不出来 ≠ 不存在。工作区里的追问答案、进度台账、文献库、检索记录都是你的资产——
   读取失败时工具**抛错并保持原文件不动**，绝不"用默认值覆盖"。

---

## 已知边界（诚实清单）

- **PDF 抽取是尽力而为**：扫描版 PDF（无文本层）、对象流/加密 PDF 可能抽不出文字，工具会明确返回原因而不是编造内容。
- **旧格式不支持**：`.doc`/`.xls`/`.ppt` 请先另存为新格式。
- **幻灯不自研生成器**：产出 Marp 兼容 Markdown，`.pptx` 依赖外部 marp/pandoc；两者都没有时给出可执行命令与兜底路径（幻灯文字已是最终稿，成稿只是排版）。
- **原创性自查不接收费系统**：无账号，也不该接入；度量口径与算法参数全部写在报告里，可复现、可质疑。
- **子进程无取消能力**：pandoc/marp/git 走 `spawnSync`，目前**不能中途取消**（有超时上限，但没有信号传递；`exec.signal` 不进入子进程）。
- **受限环境下管道 stdio 被拒**：某些沙箱里 `stdio: 'pipe'` 会 `EPERM`，插件因此默认用 `stdio: 'ignore'`（见 `src/shared/spawn.ts`）。
- **类型来自本地 shim**：为了让本仓库零依赖即可 `tsc` 通过，宿主契约以 `src/types/shims.d.ts` 声明（宽松签名），真实签名核对记录在 [docs/host-api.md](./docs/host-api.md)。
- **代码演练的语言矩阵**：验证门表内置 Go/TS/Python/Rust，其余语言需在配置里补 `gates`。
- **`dsh plugin` 需要 pnpm**：DSH 的插件安装会转发给 pnpm；机器上只有 Node 时用 `node scripts/install-into-profile.mjs --profile <名>` 兜底。

---

## 开发

```bash
npm install                 # 只装 typescript 与 schemastery
npm run build               # tsc → lib/（相对导入 .ts → .js 由 rewriteRelativeImportExtensions 处理）
npm run typecheck           # tsc --noEmit
npm test                    # node --test tests/（Node 24 直接跑 .ts，类型擦除）

# 沙箱/受限环境（禁止子进程管道，node --test 的默认隔离会 EPERM）下用同一进程跑：
npm run test:sandbox

# 完整验收：build + typecheck + 全部单测 + 全量端到端断言
npm run verify
```

### 证据分层（本仓库的质量标准）

| 层 | 命令 | 内容 |
|---|---|---|
| 单元 / 契约 | `npm run test:sandbox` | 纯逻辑、装配契约（21 工具 / 9 命令 / 2 服务 / 4 类闸门监听）、数据安全与负路径 |
| **真实场景端到端** | `npm run test:e2e` | `tests/e2e/paper-full-flow.mjs`：内置虚构学校材料夹具，离线跑完 材料→追问→建库→七章→评审→闸门→检查→docx→幻灯→原创性→答辩，逐环校验产物（含独立 ZIP 解压读回 `document.xml`） |
| **真实宿主** | `npm run test:host` | 真实 cordis + dsh-tools 装配并执行工具、真实 `agent/pre-step` 闸门注入、验证卸载注销 |
| **真实引擎装载** | `npm run test:host-load` | 真实 `dsh` 引擎解析并校验本插件。⚠️ 引擎需要写 `$DSH_HOME/profiles/<name>/cordis.yml`，在受限沙箱下需放宽文件权限 |
| 对外表面审计 | `npm run audit` | `scripts/audit-surface.mjs`：工具/命令/技能契约一致 + 宿主解析的文件无 BOM |
| 真实网络（可选） | `npm run test:net` | 真实学术 API 检索 → 收录 → 笔记 |

详细设计见 [DESIGN.md](./DESIGN.md)，宿主契约见 [docs/host-api.md](./docs/host-api.md)，
来源声明见 [NOTICE.md](./NOTICE.md)。

## 许可

MIT
