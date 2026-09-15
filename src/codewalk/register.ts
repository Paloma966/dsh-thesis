/**
 * 代码演练模块的装配入口（`apply` 之外唯一需要调用的函数）。
 *
 * 模块的角色：把 AI 写的系统代码拆成「能跑的骨架 + 可评分的追问」，
 * 保证学生答辩时讲得出自己系统的实现与取舍。引擎守住流程，模型负责教学。
 *
 * 装配顺序与 `src/index.ts` 的无关，四个表面互不依赖：
 * 引擎 → `paperCodeWalkthrough` 服务 → 命令 / 模型工具 / pre-step 注入 / 技能提供者。
 *
 * 注意：本文件只做**装配**，不导入 `src/config.ts` 的运行时值（只导入类型），
 * 因此单测可以在不安装 schemastery 的前提下直接 `import` 它。
 *
 * @module dsh-thesis/codewalk
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CodeWalkthroughOptions } from '../config.ts'
import { AiLearningEngine } from './engine.ts'
import { registerPreStep } from './prestep.ts'
import { registerSkill } from './skill.ts'
import { registerTools } from './tools.ts'

/**
 * 用宿主 `dsh-thesis` 的配置装配代码演练模块。
 *
 * @param ctx 插件 fiber 的上下文（需要 `fs`；`tools`/`skills` 可选）。
 * @param options 来自 `resolveConfig(config).codeWalkthrough` 的已解析配置。
 */
export function registerCodewalk(ctx: Context, options: CodeWalkthroughOptions): void {
  const engine = new AiLearningEngine(ctx, options)
  ctx.provide('paperCodeWalkthrough', engine)
  registerTools(ctx, engine)
  registerPreStep(ctx, engine)
  registerSkill(ctx)
}
