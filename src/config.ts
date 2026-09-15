/**
 * dsh-thesis 的统一配置 schema。
 *
 * 单一插件行 = 单一 Config：论文工作区、材料摄取、追问、原创性自查、答辩幻灯、
 * 代码演练、跨会话事实、闸门，全部在这里。`dsh plugin` 的一行 `config:` 即可覆盖。
 *
 * 三条原则：
 * 1. **默认值的单一来源**：schema 的 `.default()` 与直接 `apply()` 的代码回退
 *    共用 {@link PAPER_DEFAULTS}，绝不让「缺配置」退化成「静默关闸门」。
 * 2. **嵌套块默认值在 resolveConfig 里补齐**：schema 只校验用户写下的值，
 *    代码侧负责补全——两者不各写一份。
 * 3. **配置面只说论文的话**：字段名描述学生能理解的行为，不引入别的概念体系，也不靠继承拼接形状。
 *
 * @module dsh-thesis/config
 */

import z from '@deepseek-ai/schemastery'
import { GATE_DEFAULTS, type DestructiveRule, type GateOptions } from './gates/writing-intent.ts'
import { RECALL_DEFAULTS, type RecallOptions } from './memory/recall.ts'

export type { DestructiveRule }

/** 原创性自查 / 相似度的本地度量参数。 */
export interface SimilarityOptions {
  /** 指纹 shingle 的窗口（中文字符数；英文按 4 字符近似词）。 */
  shingle: number
  /** 判定为高风险的包含率阈值（0..1）：越高越宽松。 */
  threshold: number
  /** 参与比对的最短段落长度（字符）；更短的段落不判重（标题、公式行）。 */
  minChars: number
}

/** 答辩幻灯产出链路（Markdown 为准，转换交给外部工具）。 */
export interface PptOptions {
  /** auto = 探测 marp/pandoc，探测不到就只产出 Markdown。 */
  engine: 'auto' | 'marp' | 'pandoc' | 'none'
  /** marp 主题名（写入 frontmatter 的 `theme:`）。 */
  theme: string
  /** 单次外部转换的超时（毫秒）。 */
  timeoutMs: number
}

/** 材料到手后的逐题追问。 */
export interface IntakeOptions {
  /** 单轮追问最多问几个问题（一次一问，但允许上限）。 */
  maxQuestions: number
  /** 意图规格文档相对论文工作区根的位置。 */
  specRel: string
}

/** 文档摄取。 */
export interface IngestOptions {
  /** 单个文件读取上限（字节），超过则拒绝并提示。 */
  maxBytes: number
  /** 单次摄取写回模型的最大字符数（超出部分截断并标注）。 */
  maxChars: number
}

/** 写作风格自查（AI 味六条启发式）。 */
export interface StylecheckOptions {
  /** 报告落盘位置（相对论文工作区根）。 */
  reportRel: string
  /** 触发「长段落无锚点」判断的最短段落长度（字符）。 */
  maxParagraphChars: number
}

/** 答辩准备。 */
export interface DefenseOptions {
  /** 答辩素材落盘位置。 */
  materialsRel: string
  /** 预答辩问题库落盘位置。 */
  questionsRel: string
  /** 生成幻灯骨架时的默认页数。 */
  defaultPages: number
}

/** 代码演练：把 AI 写的系统拆成能讲清的模块（答辩必问「你的系统怎么实现的」）。 */
export interface CodeWalkthroughOptions {
  /** 状态目录（相对会话 cwd）。 */
  stateDir: string
  /** 语言 → 编译验证门命令。 */
  gates: Record<string, { build: string[] }>
  /** 每条门命令输出保留的最大字符数。 */
  maxCapturedOutput: number
}

/** 插件配置（全部可选，均有出厂默认值）。 */
export interface PaperConfig extends GateOptions {
  /** 论文工作区根；缺省从会话 cwd 向上探测 `00-管理/进度台账.md`。 */
  workspace?: string
  /** 跨会话事实库路径；缺省 `$DSH_HOME/dsh-thesis-memory.db`。 */
  memoryPath?: string
  ingest?: Partial<IngestOptions>
  intake?: Partial<IntakeOptions>
  similarity?: Partial<SimilarityOptions>
  stylecheck?: Partial<StylecheckOptions>
  ppt?: Partial<PptOptions>
  defense?: Partial<DefenseOptions>
  /** 代码演练（答辩层）。 */
  codeWalkthrough?: Partial<CodeWalkthroughOptions>
  /** 相关时把已确认的稳定事实放回上下文。 */
  recall?: Partial<RecallOptions>
}

/** 出厂默认值的单一来源。 */
export const PAPER_DEFAULTS: {
  ingest: IngestOptions
  intake: IntakeOptions
  similarity: SimilarityOptions
  stylecheck: StylecheckOptions
  ppt: PptOptions
  defense: DefenseOptions
  codeWalkthrough: CodeWalkthroughOptions
  recall: RecallOptions
} = {
  ingest: { maxBytes: 32 * 1024 * 1024, maxChars: 60_000 },
  intake: { maxQuestions: 12, specRel: '00-管理/意图规格.md' },
  similarity: { shingle: 4, threshold: 0.3, minChars: 30 },
  stylecheck: { reportRel: '08-合规/AI味自查报告.md', maxParagraphChars: 260 },
  ppt: { engine: 'auto', theme: 'default', timeoutMs: 120_000 },
  defense: {
    materialsRel: '07-答辩/答辩素材.md',
    questionsRel: '07-答辩/预答辩问题库.md',
    defaultPages: 11,
  },
  codeWalkthrough: {
    stateDir: '.paper',
    gates: {
      go: { build: ['go', 'build', './...'] },
      ts: { build: ['npm', 'run', 'typecheck'] },
      python: { build: ['python', '-m', 'compileall', '-q', '.'] },
      rust: { build: ['cargo', 'check'] },
    },
    maxCapturedOutput: 8000,
  },
  recall: RECALL_DEFAULTS,
}

/** 解析后的配置：嵌套块已补全，调用方不再处理 undefined。 */
export interface ResolvedPaperConfig {
  readonly workspace: string | undefined
  readonly memoryPath: string | undefined
  readonly ingest: IngestOptions
  readonly intake: IntakeOptions
  readonly similarity: SimilarityOptions
  readonly stylecheck: StylecheckOptions
  readonly ppt: PptOptions
  readonly defense: DefenseOptions
  readonly codeWalkthrough: CodeWalkthroughOptions
  readonly recall: RecallOptions
  /** 闸门配置：两个开关可选（缺省即由闸门自身按「开」处理），列表均已补全。 */
  readonly gates: GateOptions
}

/** 补全嵌套块默认值。 */
export function resolveConfig(config: PaperConfig = {}): ResolvedPaperConfig {
  const {
    workspace, memoryPath,
    ingest, intake, similarity, stylecheck, ppt, defense, codeWalkthrough, recall,
    writingGate, destructiveGate,
    writingIntentPatterns, criteriaMarkers, bypassMarkers, maxQuestions,
    destructiveToolNames, destructiveRules,
  } = config
  return {
    workspace,
    memoryPath,
    ingest: { ...PAPER_DEFAULTS.ingest, ...ingest },
    intake: { ...PAPER_DEFAULTS.intake, ...intake },
    similarity: { ...PAPER_DEFAULTS.similarity, ...similarity },
    stylecheck: { ...PAPER_DEFAULTS.stylecheck, ...stylecheck },
    ppt: { ...PAPER_DEFAULTS.ppt, ...ppt },
    defense: { ...PAPER_DEFAULTS.defense, ...defense },
    codeWalkthrough: {
      ...PAPER_DEFAULTS.codeWalkthrough,
      ...codeWalkthrough,
      gates: { ...PAPER_DEFAULTS.codeWalkthrough.gates, ...codeWalkthrough?.gates },
    },
    recall: { ...PAPER_DEFAULTS.recall, ...recall },
    gates: {
      ...(writingGate !== undefined ? { writingGate } : {}),
      ...(destructiveGate !== undefined ? { destructiveGate } : {}),
      writingIntentPatterns: writingIntentPatterns ?? GATE_DEFAULTS.writingIntentPatterns,
      criteriaMarkers: criteriaMarkers ?? GATE_DEFAULTS.criteriaMarkers,
      bypassMarkers: bypassMarkers ?? GATE_DEFAULTS.bypassMarkers,
      maxQuestions: maxQuestions ?? GATE_DEFAULTS.maxQuestions,
      destructiveToolNames: destructiveToolNames ?? GATE_DEFAULTS.destructiveToolNames,
      destructiveRules: destructiveRules ?? GATE_DEFAULTS.destructiveRules,
    },
  }
}

/** 单一 Config schema（cordis 启动前用它校验插件行里的 config）。 */
export const Config: z<PaperConfig> = z.object({
  // ---- 论文工作区 ----
  workspace: z.string(),
  memoryPath: z.string(),

  // ---- 材料与追问 ----
  ingest: z.object({
    maxBytes: z.natural().default(PAPER_DEFAULTS.ingest.maxBytes),
    maxChars: z.natural().default(PAPER_DEFAULTS.ingest.maxChars),
  }),
  intake: z.object({
    maxQuestions: z.natural().min(1).default(PAPER_DEFAULTS.intake.maxQuestions),
    specRel: z.string().default(PAPER_DEFAULTS.intake.specRel),
  }),

  // ---- 原创性自查 ----
  similarity: z.object({
    shingle: z.natural().default(PAPER_DEFAULTS.similarity.shingle),
    threshold: z.number().default(PAPER_DEFAULTS.similarity.threshold),
    minChars: z.natural().default(PAPER_DEFAULTS.similarity.minChars),
  }),

  // ---- 写作风格自查 ----
  stylecheck: z.object({
    reportRel: z.string().default(PAPER_DEFAULTS.stylecheck.reportRel),
    maxParagraphChars: z.natural().default(PAPER_DEFAULTS.stylecheck.maxParagraphChars),
  }),

  // ---- 答辩：幻灯 + 素材 + 代码演练 ----
  ppt: z.object({
    engine: z.union([
      z.const('auto'),
      z.const('marp'),
      z.const('pandoc'),
      z.const('none'),
    ]).default(PAPER_DEFAULTS.ppt.engine),
    theme: z.string().default(PAPER_DEFAULTS.ppt.theme),
    timeoutMs: z.natural().default(PAPER_DEFAULTS.ppt.timeoutMs),
  }),
  defense: z.object({
    materialsRel: z.string().default(PAPER_DEFAULTS.defense.materialsRel),
    questionsRel: z.string().default(PAPER_DEFAULTS.defense.questionsRel),
    defaultPages: z.natural().min(1).default(PAPER_DEFAULTS.defense.defaultPages),
  }),
  codeWalkthrough: z.object({
    stateDir: z.string().default(PAPER_DEFAULTS.codeWalkthrough.stateDir),
    gates: z.dict(z.object({
      build: z.array(z.string()),
    })).default(PAPER_DEFAULTS.codeWalkthrough.gates),
    maxCapturedOutput: z.natural().default(PAPER_DEFAULTS.codeWalkthrough.maxCapturedOutput),
  }),

  // ---- 跨会话事实 ----
  recall: z.object({
    maxEntries: z.natural().default(PAPER_DEFAULTS.recall.maxEntries),
    maxChars: z.natural().default(PAPER_DEFAULTS.recall.maxChars),
    minKeywordLength: z.natural().min(1).default(PAPER_DEFAULTS.recall.minKeywordLength),
  }),

  // ---- 闸门 ----
  writingGate: z.boolean().default(true),
  writingIntentPatterns: z.array(z.string()).default(GATE_DEFAULTS.writingIntentPatterns),
  criteriaMarkers: z.array(z.string()).default(GATE_DEFAULTS.criteriaMarkers),
  bypassMarkers: z.array(z.string()).default(GATE_DEFAULTS.bypassMarkers),
  maxQuestions: z.natural().min(1).default(GATE_DEFAULTS.maxQuestions),
  destructiveGate: z.boolean().default(true),
  destructiveToolNames: z.array(z.string()).default(GATE_DEFAULTS.destructiveToolNames),
  destructiveRules: z.array(z.object({
    label: z.string(),
    pattern: z.string(),
  })).default(GATE_DEFAULTS.destructiveRules),
})
