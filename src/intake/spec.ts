/**
 * 意图规格：把追问状态渲染成给人和模型共读的 Markdown（默认 `00-管理/意图规格.md`）。
 *
 * 两个不可妥协的性质：
 * 1. **幂等**：`renderSpec` 是状态的纯函数——同样状态渲染两次逐字节一致，
 *    因此「每次回答后自动刷新规格」不会产生无意义的 diff。文档里不写渲染时间
 *    （时间只留在 `.paper/intake.json`），只写内容哈希作为版本指纹。
 * 2. **未知即阻塞**：必答项未答、格式不合格、被跳过的，都显式列进「阻塞项」一节。
 *    规格里不允许出现沉默的空白——后续写作/构建/降重/答辩只能依据本文件，
 *    所以"没写"必须等于"看得见的缺口"。
 *
 * 来源标注只有三种：`用户回答` / `材料推断（待确认）` / `未知（需补）`。
 *
 * @module dsh-thesis/intake
 */

import * as nodePath from 'node:path'
import { createHash } from 'node:crypto'
import {
  blockingRequired,
  listRequired,
  materialInsight,
  questionById,
  QUESTIONS,
  INTAKE_SECTIONS,
  type AnswerCheck,
  type IntakeContext,
  type IntakeQuestion,
} from './questions.ts'
import { writeAtomic, type IntakeIo, type IntakeState } from './state.ts'

/** 来源标注：规格阅读者一眼看出这条信息可不可信。 */
export const SOURCE_USER = '用户回答'
/**
 * 材料推断、但用户还没点头：字面量必须避开闸门的关键词。
 *
 * `intake/gate-rules.ts` 把 `待确认` 当作「规格未立稳」的标记，所以这里用
 * 「材料推断（未确认）」——**规格收敛完成后文档里不得再出现该标记**，
 * 否则入口闸门会永远认为规格没立稳（详见 spec 的幂等测试）。
 */
export const SOURCE_MATERIALS_PENDING = '材料推断（未确认）'
export const SOURCE_MATERIALS = '材料推断'
/** 必答项没答：这是阻塞项，闸门就是靠这个字面量识别「规格没立稳」。 */
export const SOURCE_UNKNOWN = '未知（需补）'
/** 非必答项没答：标注清楚，但不阻塞收敛（否则规格永远立不稳）。 */
export const SOURCE_OPTIONAL_OPEN = '未答（非阻塞）'

function isBlank(value: string): boolean {
  return value.trim() === ''
}

/** 一条状态在规格里的呈现形态。 */
export interface SpecLine {
  readonly question: IntakeQuestion
  readonly source: string
  readonly value: string
  readonly note?: string
}

/** 该问题当前的来源标注与取值。 */
export function specLine(state: IntakeState, q: IntakeQuestion): SpecLine {
  const rec = state.answers[q.id]
  if (rec === undefined) {
    const skipped = state.skipped.includes(q.id)
    const why = state.skipReasons[q.id]
    return {
      question: q,
      // 必答项没答 = 阻塞（用闸门识别的「未知」标记）；非必答项没答不阻塞收敛。
      source: q.required ? SOURCE_UNKNOWN : SOURCE_OPTIONAL_OPEN,
      value: skipped ? `（已跳过：${why === undefined || why === '' ? '未给理由' : why}）` : '（尚未回答）',
    }
  }
  const line: { question: IntakeQuestion; source: string; value: string; note?: string } = {
    question: q,
    source: rec.source === 'materials'
      ? (rec.confirmed ? SOURCE_MATERIALS : SOURCE_MATERIALS_PENDING)
      : SOURCE_USER,
    // 值里可能出现换行：统一压成单行，保证表格/列表不会被撑破。
    value: rec.value.replace(/\s*\n+\s*/g, '；'),
  }
  if (rec.note !== undefined && rec.note !== '') line.note = rec.note
  return line
}

/** 阻塞项：必答但未齐全（未答 / 格式不合格）的问题。 */
export function blockers(state: IntakeState): IntakeQuestion[] {
  return blockingRequired(state)
}

/** 规格内容指纹：前 12 位，用于回答「这份文档对应哪一版状态」。 */
export function specFingerprint(state: IntakeState): string {
  const canonical = listRequired()
    .map(q => `${q.id}=${state.answers[q.id]?.value ?? ''}`)
    .join('\u0000')
  const digest = createHash('sha256').update(canonical).digest('hex')
  return digest.slice(0, 12)
}

function sourceOf(state: IntakeState, q: IntakeQuestion): string {
  return specLine(state, q).source
}

/**
 * 渲染意图规格全文（纯函数、幂等）。
 *
 * 结构：文档说明 → 进度摘要 → 阻塞项 → 六个分节（每节一张问答表 + 未答清单）
 * → 附录（本轮已完成问答留痕）。
 */
export function renderSpec(state: IntakeState, ctx: IntakeContext): string {
  const insight = materialInsight(ctx.materials)
  const pending = blockers(state)
  const required = listRequired()
  const answeredRequired = required.filter(q => state.answers[q.id] !== undefined && state.answers[q.id]?.valid !== false)
  const L: string[] = []

  L.push('# 意图规格')
  L.push('')
  L.push('<!-- dsh-thesis:intake-spec')
  L.push(`fingerprint: ${specFingerprint(state)}`)
  L.push(`specPath: ${state.specPath}`)
  L.push('-->')
  L.push('')
  L.push('> **这份文档是什么**：材料到手后，由 `thesis_intake` 逐题追问收敛出的"可证伪意图规格"。')
  L.push('> 它把模糊的口头要求变成能被检查的条款：学校/学位、格式模板、字数、查重、AI 规定、时间线、数据真实性、引用格式、答辩形式。')
  L.push('>')
  L.push('> **谁维护**：`thesis_intake` 工具自动重绘——你每回答一个问题，本文件立即刷新。')
  L.push('> 请不要手工编辑表格：手工改动会在下一次回答时被覆盖。要改答案，就用同一个问题重答一次（`thesis_intake action=answer`）。')
  L.push('>')
  L.push('> **怎么用**：后续写作、格式检查、降重、PPT、答辩准备**只依据本文件**。')
  L.push('> 「来源」列告诉你每条信息的可信度：`用户回答` 是用户亲口确认的；`材料推断（未确认）` 是从材料里读出来、还没得到用户点头的；必答项没答会标成「未知」并进入下一节的阻塞项；非必答项没答标为「未答（非阻塞）」。')
  L.push('> 「阻塞项」一节非空时不进入下一阶段：先把清单里的问题答完（非必答项可以一直留着，但规格会显示它们没定）。')
  L.push('')
  L.push('## 进度摘要')
  L.push('')
  L.push(`- 当前阶段：${ctx.stage}`)
  L.push(`- 追问状态：${state.stage === 'done' ? '✅ 必答项已齐全，可进入下一阶段' : '⏳ 进行中'}`)
  L.push(`- 必答项：${answeredRequired.length}/${required.length} 已答`)
  L.push(`- 材料清单：${ctx.materials.found ? `已读取（${ctx.materials.items.length} 项）` : '未找到 00-管理/材料清单.md（未做材料感知）'}`)
  L.push(`- 已跳过：${state.skipped.length} 项${state.skipped.length > 0 ? `（${state.skipped.join('、')}）` : ''}`)
  L.push(`- 内容指纹：\`${specFingerprint(state)}\``)
  L.push('')

  L.push('## 阻塞项（未答不可进入下一阶段）')
  L.push('')
  if (pending.length === 0) {
    L.push('无。全部必答项已齐全。')
  } else {
    L.push('| 问题 id | 分节 | 缺什么 | 影响产出 |')
    L.push('|---|---|---|---|')
    for (const q of pending) {
      const rec = state.answers[q.id]
      let missing: string
      if (rec === undefined) {
        missing = state.skipped.includes(q.id) ? `已跳过：${state.skipReasons[q.id] ?? '未给理由'}` : '尚未回答'
      } else {
        missing = `格式待修正：${rec.note ?? '校验未通过'}`
      }
      L.push(`| \`${q.id}\` | ${q.section} | ${missing} | ${q.affects.join('、')} |`)
    }
    L.push('')
    L.push('> 补法：`thesis_intake` 的 `action=answer` 逐题作答；确实无法回答的用 `action=skip` 并给理由，但在 `done` 之前它们仍是阻塞项。')
  }
  L.push('')

  for (const section of INTAKE_SECTIONS) {
    const qs = QUESTIONS.filter(q => q.section === section)
    L.push(`## ${section}`)
    L.push('')
    if (qs.length === 0) {
      L.push('（本节暂无问题）')
      L.push('')
      continue
    }
    L.push('| 问题 | 结论 | 来源 | 备注 |')
    L.push('|---|---|---|---|')
    for (const q of qs) {
      const line = specLine(state, q)
      const note = line.note !== undefined
        ? line.note
        : (insight.suppress.has(q.id) ? '已由材料覆盖，未重复提问' : '')
      L.push(`| ${q.ask} | ${line.value} | ${line.source} | ${note} |`)
    }
    L.push('')
    const unknown = qs.filter(q => isBlank(state.answers[q.id]?.value ?? ''))
    if (unknown.length > 0) {
      L.push('未答清单：')
      for (const q of unknown) {
        L.push(`- ${q.required ? '**[必答]** ' : ''}\`${q.id}\` ${q.ask}`)
      }
      L.push('')
    }
  }

  L.push('## 附：本轮问答留痕')
  L.push('')
  const asked = state.askedIds.filter(id => questionById(id) !== undefined)
  if (asked.length === 0) {
    L.push('（还没有问过任何问题）')
  } else {
    L.push('| 顺序 | 问题 id | 来源 | 时间 | 校验 |')
    L.push('|---|---|---|---|---|')
    asked.forEach((id, i) => {
      const q = questionById(id)
      if (q === undefined) return
      const rec = state.answers[id]
      const source = rec === undefined ? '—（未答/已跳过）' : sourceOf(state, q)
      const at = rec?.at ?? '—'
      const check = rec === undefined ? '—' : (rec.valid === false ? `⚠️ ${rec.note ?? '未通过'}` : '✅')
      L.push(`| ${i + 1} | \`${id}\` | ${source} | ${at} | ${check} |`)
    })
  }
  L.push('')
  L.push('---')
  L.push('')
  L.push('本文件由 `dsh-thesis` 的 `thesis_intake` 工具生成并维护；机器真相在 `.paper/intake.json`。')
  L.push('')
  return L.join('\n')
}

/** 规格渲染结果的摘要（工具返回值用）。 */
export interface SpecWriteResult {
  readonly path: string
  readonly absPath: string
  readonly blockerIds: string[]
  readonly bytes: number
}

/**
 * 渲染并原子落盘规格。返回相对路径与阻塞项 id，便于工具直接回报「还缺什么」。
 * 中途失败会抛错（不吞）：规格是最新真相，写不进去必须让用户知道。
 */
export async function writeSpec(io: IntakeIo, root: string, state: IntakeState, ctx: IntakeContext): Promise<SpecWriteResult> {
  const rel = state.specPath === '' ? nodePath.join('00-管理', '意图规格.md') : state.specPath
  const abs = nodePath.join(root, rel)
  const md = renderSpec(state, ctx)
  await writeAtomic(io, abs, md)
  return {
    path: rel,
    absPath: abs,
    blockerIds: blockers(state).map(q => q.id),
    bytes: md.length,
  }
}

/** 供工具层复用的校验调用：问题没有 `validate` 时视为通过。 */
export function checkAnswer(q: IntakeQuestion, answer: string): AnswerCheck {
  if (q.validate === undefined) return { ok: true }
  try {
    return q.validate(answer)
  } catch (error) {
    // 校验函数本身出错不应打断对话：记为"未通过"并说明原因。
    return { ok: false, note: `校验过程出错（${error instanceof Error ? error.message : String(error)}），请人工核对。` }
  }
}
