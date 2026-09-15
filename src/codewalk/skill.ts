/**
 * 随包发布的 `code-walkthrough` 技能提供者（答辩层的代码演练方法论）。
 *
 * 把「答辩前把自己的系统讲清楚」的方法论打包成一个 Markdown 技能
 * （与 `@deepseek-ai/dsh-skill-badge` 同一套做法）：只登记一个不可变候选，
 * 正文从包的 `skills/code-walkthrough/` 目录读取，并把该目录暴露为资源基址，
 * 因此正文里的 `references/*.md` 可以按需通过技能工具加载。
 * 方法论始终是可编辑的 Markdown —— 插件代码只承载机制。
 *
 * @module dsh-thesis/codewalk
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {
  SkillCandidateShape,
  SkillDefinitionShape,
  SkillsProviderShape,
  SkillsServiceShape,
} from './host-types.ts'

const SKILL_DIR_URL = new URL('../../skills/code-walkthrough/', import.meta.url)
const SKILL_BODY_URL = new URL('SKILL.md', SKILL_DIR_URL)
/** 技能正文的磁盘路径；`readFile` 在本仓库的类型面里只接受字符串路径。 */
const SKILL_BODY_PATH = fileURLToPath(SKILL_BODY_URL)
const RESOURCE_BASE = { kind: 'directory', path: fileURLToPath(SKILL_DIR_URL) } as const

export const SKILL_NAME = 'code-walkthrough'
const PROVIDER_NAME = 'dsh-thesis'

const DESCRIPTION =
  '把自己系统（常常是 AI 写的）拆成能讲清的模块，并用可评分的追问确认你在答辩席上讲得出实现细节与取舍。' +
  '答辩几乎必问「你的系统怎么实现的」「为什么这么设计」，答不上来是最常见的失分点。' +
  '触发场景：「答辩前我要搞懂自己系统的实现」「老师会问实现细节」「把这些代码拆成我讲得清的部分」。'

const WHEN_TO_USE =
  '当用户说「答辩前要把自己的系统讲明白」「老师会问实现细节/为什么这么设计」「帮我理清这套代码好答辩」，' +
  '或在 `thesis_defense` 生成了预答辩问题库、需要逐个准备「实现细节」类问题时触发。'

const INVOCATION = { modelInvocable: true, userInvocable: true } as const

const CANDIDATE: SkillCandidateShape = {
  name: SKILL_NAME,
  description: DESCRIPTION,
  whenToUse: WHEN_TO_USE,
  invocation: INVOCATION,
  provider: PROVIDER_NAME,
  source: 'bundled',
  resourceBase: RESOURCE_BASE,
  // 低于所有本地文件系统来源（100–600），因此用户自己的同名技能会优先；
  // 同时足够高，不会抢别的技能。
  rank: 900,
  locator: SKILL_BODY_URL,
}

const provider: SkillsProviderShape = {
  name: PROVIDER_NAME,
  list: () => Promise.resolve([CANDIDATE]),
  async get(_candidate): Promise<SkillDefinitionShape> {
    return {
      ...CANDIDATE,
      ...(CANDIDATE.whenToUse !== undefined ? { whenToUse: CANDIDATE.whenToUse } : {}),
      content: await readFile(SKILL_BODY_PATH, 'utf8'),
    }
  },
}

/** 组合了技能注册表时注册这个随包技能提供者。 */
export function registerSkill(ctx: Context): void {
  const skills = ctx.get('skills') as SkillsServiceShape | undefined
  if (skills === undefined) return
  skills.registerProvider(() => provider)
}
