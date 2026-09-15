/**
 * dsh-thesis：论文与答辩全流程助手（DeepSeek Harness 单一插件）。
 *
 * 本文件是**唯一装配层**：把各能力挂到同一个插件 fiber 上，对外只有一行
 * `dsh plugin add dsh-thesis`、一个 Config、一套技能。
 *
 * | 目录 | 职责 |
 * |---|---|
 * | `paper/` | 论文工作区：台账 / 关卡 / 文献 / 评审 / 检查 / docx 构建 / 答辩素材 |
 * | `ingest/` | 材料摄取：Office/PDF/代码/文本 → 可读摘要与材料清单 |
 * | `intake/` | 材料到手后的逐题追问 → 意图规格（唯一真相） |
 * | `dedup/` | 原创性自查：本地相似度度量 + 改写处方 + 复测 |
 * | `ppt/` | 答辩幻灯：Marp Markdown + 外部转换器探测 |
 * | `memory/` | 跨会话事实：学校规范、导师要求、写作偏好（学生不必直接调用） |
 * | `codewalk/` | 代码演练：把 AI 写的系统拆成答辩讲得清的模块 |
 * | `gates/` | 闸门：写作意图闸门 + 不可逆操作闸门 + 意图规格闸门 |
 * | `shared/` | 工具胶水、工具定义器、文本与文件系统错误工具 |
 *
 * **一个领域模型**：材料 → 要求 → 九阶段 → 论文与答辩。学生的工具清单里
 * 只有 `thesis_*`（论文工作区）与 `fact_*`（跨会话事实）两个命名空间。
 *
 * @module dsh-thesis
 */

import type { Context } from '@deepseek-ai/cordis'
import { fileURLToPath } from 'node:url'
import { registerCodewalk } from './codewalk/register.ts'
import { registerDefenseCommand } from './commands.ts'
import { Config, resolveConfig, type PaperConfig } from './config.ts'
import { registerDedup } from './dedup/index.ts'
import { installDangerousGate } from './gates/dangerous.ts'
import { installWritingGate } from './gates/prompt.ts'
import { registerIngest } from './ingest/index.ts'
import { installIntakeGate } from './intake/gate.ts'
import { registerIntake } from './intake/index.ts'
import { installFactRecall, registerFacts } from './memory/register.ts'
import { setWorkspaceRoot } from './paper/lib/project.ts'
import { registerPaper } from './paper/register.ts'
import { registerPpt } from './ppt/index.ts'

export const name = 'dsh-thesis'

export const inject = ['tools', 'fs', 'commands']

export { Config }
export { PAPER_DEFAULTS, resolveConfig, type PaperConfig, type ResolvedPaperConfig } from './config.ts'

/** 随包发布的技能目录（`thesis_init` 复制到论文仓库 `.dsh/skills/`）。 */
const SKILLS_DIR = fileURLToPath(new URL('../skills', import.meta.url))

/**
 * 装配全部能力。
 *
 * 顺序无关紧要（各模块互不依赖装配顺序），但**闸门最后装**：pre-step 监听器
 * 需要已经存在的工具与技能上下文，且日志顺序更易读。
 */
export function apply(ctx: Context, config: PaperConfig = {}): void {
  const resolved = resolveConfig(config)

  // 工作区根：配置显式指定时优先，否则由各工具从会话 cwd 向上探测台账。
  setWorkspaceRoot(resolved.workspace)

  // 跨会话事实：先装配，便于后续模块记录已确认的要求。
  registerFacts(ctx, resolved.memoryPath)
  // 事实回灌：相关时自动把已确认的稳定事实放回上下文（不相关则完全静默）。
  installFactRecall(ctx, resolved.recall)

  // 论文工作区：11 个工具 + 5 个命令。
  registerPaper(ctx, { skillsDir: SKILLS_DIR })

  // 代码演练（答辩层）：3 个工具 + 进度卡注入 + code-walkthrough 技能。
  registerCodewalk(ctx, resolved.codeWalkthrough)

  // 材料入口：Office 摄取 → 文本与材料清单。
  registerIngest(ctx, { ingest: resolved.ingest })

  // 意图规格：逐题追问状态机 + `/thesis-intake`。
  registerIntake(ctx, { intake: resolved.intake })

  // 原创性自查：本地度量 + 改写处方 + 复测。
  registerDedup(ctx, { similarity: resolved.similarity })

  // 答辩：Markdown 幻灯 + 外部转换器探测。
  registerPpt(ctx, { ppt: resolved.ppt })

  // 答辩命令：幻灯侧与代码演练侧在装配层聚合为 `/thesis-defense`。
  registerDefenseCommand(ctx, { ppt: resolved.ppt })

  // 闸门：写作意图闸门 + 不可逆操作闸门 + 意图规格闸门。
  installWritingGate(ctx, resolved.gates)
  installDangerousGate(ctx, resolved.gates)
  installIntakeGate(ctx, { specRel: resolved.intake.specRel })
}
