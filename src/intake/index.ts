/**
 * `thesis_intake`：材料到手后的逐题追问（一次一问 → 可证伪意图规格）。
 *
 * 产品链路：`thesis_ingest` 把学校模板/论文要求/实验数据/代码/参考文献读进工作区 →
 * 本工具**逐题追问**，把模糊要求变成可检查的条款 → 落盘 `00-管理/意图规格.md` →
 * 后续写作/格式检查/降重/PPT/答辩**只依据该规格**。
 *
 * 三条硬要求（全部在代码里强制，不靠模型自觉）：
 * 1. **一次只问一个**：任何 action 的返回里最多出现一个问题；
 * 2. **规格永远最新**：每次 `answer`/`skip` 之后立即重绘并原子落盘规格；
 * 3. **必答项不齐不许 `done`**：`done` 会拒绝并列出缺口，绝不放水。
 *
 * 本文件是**执行层 + 装配入口**：执行层零 `@deepseek-ai/*` 运行时导入（只借用它们的类型），
 * 因此测试可以直接用假 fs 驱动 {@link runIntake}；`registerIntake` 只在装配时调用宿主能力。
 *
 * @module dsh-thesis/intake
 */

import type { Context } from '@deepseek-ai/cordis'
import { definePaperTool, sessionCwd, textOutput } from '../shared/index.ts'
import {
  INTAKE_ACTIONS,
  intakeToolDefinition,
  type IntakeArgs,
  type IntakeSubOptions,
} from './definitions.ts'
import {
  blockingRequired,
  clampQueue,
  listRequired,
  makeContext,
  materialInsight,
  nextQuestion,
  questionById,
  questionQueue,
  QUESTIONS,
  type IntakeContext,
  type IntakeQuestion,
} from './questions.ts'
import {
  applyAnswer,
  applySkip,
  defaultState,
  fsIo,
  loadMaterials,
  loadStage,
  loadState,
  markAsked,
  saveState,
  setStage,
  type FileSystemLike,
  type IntakeIo,
  type IntakeState,
} from './state.ts'
import { checkAnswer, writeSpec } from './spec.ts'
import { findThesisRoot } from '../paper/lib/project.ts'

/** 规格默认位置（配置项缺省时使用）。 */
const SPEC_DEFAULT_REL = '00-管理/意图规格.md'


/** 找不到工作区的统一指引（不抛裸异常）。 */
export async function requireThesisRoot(fs: FileSystemLike, cwd: string | undefined, signal?: AbortSignal): Promise<string | null> {
  return await findThesisRoot(fs as never, cwd, signal)
}

/** 载入追问上下文：材料清单 + 台账阶段（都读不到就退化为默认值）。 */
export async function loadContext(io: IntakeIo, root: string): Promise<IntakeContext> {
  const [materials, stage] = await Promise.all([loadMaterials(io, root), loadStage(io, root)])
  return makeContext(materials, stage)
}

/** 规格相对路径：配置为空时回退到默认位置。 */
export function specRelOf(intake: IntakeSubOptions): string {
  const rel = typeof intake.specRel === 'string' ? intake.specRel.trim() : ''
  return rel === '' ? SPEC_DEFAULT_REL : rel
}

/** 读状态；不存在则建一份（`specPath` 用配置里的路径，保证后续渲染一致）。 */
async function loadOrInit(io: IntakeIo, root: string, intake: IntakeSubOptions): Promise<{ state: IntakeState; created: boolean }> {
  const found = await loadState(io, root)
  if (found !== undefined) {
    if (found.specPath === '') found.specPath = specRelOf(intake)
    return { state: found, created: false }
  }
  const fresh = defaultState(new Date(), specRelOf(intake))
  await saveState(io, root, fresh)
  return { state: fresh, created: true }
}

/** 进度一句话：必答项已答数 + 未答 + 格式待修正。 */
export function progressLine(state: IntakeState): string {
  const required = listRequired()
  const answered = required.filter(q => state.answers[q.id] !== undefined && state.answers[q.id]?.valid !== false)
  const missing = required.filter(q => state.answers[q.id] === undefined)
  const invalid = required.filter(q => state.answers[q.id]?.valid === false)
  const parts: string[] = [`必答项 ${answered.length}/${required.length} 已答`]
  if (missing.length > 0) parts.push(`未答：${missing.map(q => q.id).join('、')}`)
  if (invalid.length > 0) parts.push(`格式待修正：${invalid.map(q => q.id).join('、')}`)
  return parts.join('；')
}

/** 问题卡片：一次只渲染一个问题，包含 why / 影响 / 合格答案形态 / hint。 */
function questionCard(q: IntakeQuestion, state: IntakeState, ctx: IntakeContext, extra: string[] = []): string {
  const insight = materialInsight(ctx.materials)
  const auto = insight.autoAnswers.get(q.id)
  const rec = state.answers[q.id]
  const lines: string[] = []
  if (extra.length > 0) lines.push(...extra, '')
  lines.push(`【下一个问题】${q.id} · ${q.section}`)
  lines.push(`问：${q.ask}`)
  lines.push(`为什么问：${q.why}`)
  lines.push(`影响产出：${q.affects.join('、')}`)
  lines.push(`合格答案：${q.answerShape}`)
  if (q.hint !== undefined) lines.push(`答不上来？${q.hint}`)
  if (auto !== undefined && (rec === undefined || !rec.confirmed)) {
    lines.push('')
    lines.push(`💡 材料里已经有答案了：${auto.value}`)
    lines.push(`依据：${auto.evidence}`)
    lines.push('请确认这条信息对不对（对就回「对」，不对就给出正确内容），确认后我不再重复问。')
  }
  if (q.required) lines.push('', '⚠️ 这是必答项：不回答就无法完成追问（done 会拒绝）。')
  lines.push('')
  lines.push(`进度：${progressLine(state)}`)
  lines.push(`作答：thesis_intake action=answer question_id=${q.id} answer=<你的答案>`)
  lines.push(`答不了：thesis_intake action=skip question_id=${q.id} reason=<理由>`)
  return lines.join('\n')
}

/** 会话内问题数达到 maxQuestions 时的收尾提示（不追问、不静默）。 */
function capReached(state: IntakeState, maxQuestions: number, specRel: string, ctx: IntakeContext): string {
  const remaining = questionQueue(state, ctx).filter(q => state.answers[q.id] === undefined)
  const head = remaining[0]
  return [
    `本次会话的追问上限（maxQuestions=${maxQuestions}）已到，先停在这里，避免一次问太多。`,
    `进度：${progressLine(state)}`,
    head !== undefined ? `还剩 ${remaining.length} 个可问的问题（下一个是 ${head.id}：${head.ask}）` : '当前没有待问的问题。',
    '',
    '下一步：新开一轮继续追问（同一工具再调一次即可，状态已落盘，会从当前问题接着问）；',
    `或者先看规格：thesis_intake action=spec（落盘到 ${specRel}）。`,
    '必答项齐全后：thesis_intake action=done。',
  ].join('\n')
}

/** 追问完成：报告规格位置与必答项摘要。 */
function completionReport(state: IntakeState, specRel: string, blockersNow: readonly IntakeQuestion[]): string {
  const lines: string[] = []
  lines.push('✅ 必答项已齐全，意图规格收敛完成。')
  lines.push(`规格文件：${specRel}（内容指纹已在文件头标注）`)
  lines.push(`必答项：${listRequired().length}/${listRequired().length} 已答；全部问题已答 ${Object.keys(state.answers).length}/${QUESTIONS.length}`)
  if (blockersNow.length > 0) {
    lines.push(`注意：仍有 ${blockersNow.length} 个必答项未通过格式校验（${blockersNow.map(q => q.id).join('、')}），请重答修正。`)
  }
  const skipped = state.skipped.length
  lines.push(skipped > 0 ? `已跳过 ${skipped} 项（不影响 done，但规格里会标注为未知）：${state.skipped.join('、')}` : '没有跳过任何问题。')
  lines.push('')
  lines.push('下一步：让写作/格式检查/降重/PPT/答辩都依据这份规格；规格有变动时重答对应问题即可自动刷新。')
  return lines.join('\n')
}

/**
 * 执行一次 `thesis_intake` 调用（纯 I/O，零 cordis 依赖）。
 *
 * @param sessionAsked 本次会话已经问过的问题数（由调用方累加，用于 `maxQuestions` 上限）。
 */
export async function runIntake(
  fs: FileSystemLike,
  intake: IntakeSubOptions,
  args: IntakeArgs,
  cwd: string | undefined,
  signal?: AbortSignal,
  sessionAsked = 0,
): Promise<string> {
  const action = typeof args.action === 'string' ? args.action.trim() : ''
  if (!INTAKE_ACTIONS.includes(action)) {
    return `未知 action：${action === '' ? '（空）' : action}。有效值：${INTAKE_ACTIONS.join(' | ')}。\n用法：先 action=start（初始化或读取状态并返回第一个问题），再对每个问题 action=answer。`
  }

  const root = await requireThesisRoot(fs, cwd, signal)
  if (root === null) {
    return [
      '未找到论文工作区（从当前目录向上查找 00-管理/进度台账.md 失败）。',
      '请先创建并进入论文工作区：thesis_init root=<绝对路径> title=<题目>，然后在该目录里重试。',
      '如果工作区已存在，请在论文仓库目录内调用本工具（工具按会话工作目录向上探测）。',
    ].join('\n')
  }

  /**
   * I/O 全部走 `ctx.fs`（含临时文件的写入与清理）。
   *
   * 这里刻意不注入基于 `node:fs/promises` 的改名：`ctx.fs` 之外的真实文件写入会绕过
   * 宿主沙箱与观测，且让假 fs 测试失真。原子语义由「同目录临时文件 + 覆盖写 + 清理临时文件」
   * 保证；`state.ts` 的 `IntakeIo.rename` 给需要真改名的宿主留了注入点。
   */
  const io = fsIo(fs, signal)
  const specRel = specRelOf(intake)
  const maxQuestions = Math.max(1, Math.floor(intake.maxQuestions))

  try {
    switch (action) {
      case 'start': {
        const { state, created } = await loadOrInit(io, root, intake)
        const ctx = await loadContext(io, root)
        const written = await writeSpec(io, root, state, ctx)
        await saveState(io, root, state)
        const lead = created
          ? `已初始化追问状态（.paper/intake.json）并生成规格：${written.path}`
          : `已读取既有追问状态（可断点续问）：${state.stage === 'done' ? '必答项已齐全' : '进行中'}`
        if (state.stage === 'done' && blockingRequired(state).length === 0) {
          return `${lead}\n\n${completionReport(state, written.path, [])}`
        }
        const q = nextQuestion(state, ctx)
        if (q === undefined) {
          return `${lead}\n\n本轮没有待问的问题。\n进度：${progressLine(state)}\n下一步：thesis_intake action=done（校验必答项并收尾）。`
        }
        return questionCard(q, state, ctx, [lead, '一次只问一个问题——答完这个再问下一个。'])
      }

      case 'ask': {
        const { state } = await loadOrInit(io, root, intake)
        const ctx = await loadContext(io, root)
        if (sessionAsked >= maxQuestions) return capReached(state, maxQuestions, specRel, ctx)
        const q = nextQuestion(state, ctx)
        if (q === undefined) {
          const blockersNow = blockingRequired(state)
          if (blockersNow.length === 0) {
            return `没有待问的问题了。\n${completionReport(state, specRel, [])}`
          }
          return [
            '没有可问的新问题了，但必答项还没齐——只剩被跳过的必答项，需要直接回答（不能靠 skip 过关）。',
            `缺口：${blockersNow.map(b => `${b.id}（${b.ask}）`).join('；')}`,
            '下一步：thesis_intake action=answer question_id=<id> answer=<答案>',
          ].join('\n')
        }
        const asked = Math.min(sessionAsked + 1, maxQuestions)
        return questionCard(q, state, ctx, [`第 ${asked}/${maxQuestions} 个问题（本次会话上限）`])
      }

      case 'answer': {
        const id = typeof args.question_id === 'string' ? args.question_id.trim() : ''
        const raw = typeof args.answer === 'string' ? args.answer : ''
        if (id === '') return 'action=answer 需要 question_id（问题 id，如 school.template）。先 action=ask 取当前该答的问题。'
        if (raw.trim() === '') return `action=answer 需要 answer（问题 ${id} 的答案原文不能为空）。确实答不了的用 action=skip 并给理由。`
        const q = questionById(id)
        if (q === undefined) {
          const current = await loadOrInit(io, root, intake)
          const ctx = await loadContext(io, root)
          const queue = questionQueue(current.state, ctx).slice(0, 5).map(x => x.id)
          return `未知问题 id：${id}。\n当前可答的问题：${queue.join('、') || '（无，先 action=ask）'}`
        }
        const { state } = await loadOrInit(io, root, intake)
        const ctx = await loadContext(io, root)
        const insight = materialInsight(ctx.materials)
        const auto = insight.autoAnswers.get(q.id)
        // 材料已给出答案：用户回「对/是/确认」即确认，回别的内容按纠正处理。
        const looksConfirm = auto !== undefined && /^(对|是|是的|确认|没错|正确|ok|好|可以|yes|y)$/i.test(raw.trim())
        const value = looksConfirm ? auto!.value : raw
        const check = checkAnswer(q, value)
        const result = applyAnswer(state, q.id, value, {
          source: looksConfirm ? 'materials' : 'user',
          confirmed: true,
          valid: check.ok,
          note: check.note,
        })
        const written = await writeSpec(io, root, state, ctx)
        await saveState(io, root, state)
        const echo: string[] = [
          looksConfirm
            ? `已确认（来源：材料推断）：${q.id} = ${value}`
            : `已记录：${q.id} = ${result.record.value}${result.changed ? '' : '（与上次相同，未重复记录）'}`,
        ]
        // 已回答 + 即将问的都要记进 askedIds：前者是断点续问的进度，后者是 maxQuestions 的计分。
        markAsked(state, q.id, new Date())
        const next = nextQuestion(state, ctx)
        if (next !== undefined) markAsked(state, next.id, new Date())
        await saveState(io, root, state)
        if (check.ok) {
          if (check.note !== undefined) echo.push(`提醒：${check.note}`)
        } else {
          echo.push(`⚠️ 格式提醒：${check.note ?? '未通过校验'}（已按原样记录；必答项格式不合格时 done 会拒绝）`)
        }
        echo.push(`规格已刷新：${written.path}`)
        if (next === undefined) {
          const blockersNow = blockingRequired(state)
          if (blockersNow.length === 0) {
            echo.push('')
            echo.push(completionReport(state, written.path, []))
            return echo.join('\n')
          }
          echo.push('')
          echo.push('没有可问的新问题了，但还有必答缺口（可能是被跳过或格式不合格的）：')
          echo.push(blockersNow.map(b => `- ${b.id}：${b.ask}`).join('\n'))
          echo.push('下一步：thesis_intake action=done 查看缺口，或直接 answer 补答。')
          return echo.join('\n')
        }
        return questionCard(next, state, ctx, echo)
      }

      case 'skip': {
        const id = typeof args.question_id === 'string' ? args.question_id.trim() : ''
        const reason = typeof args.reason === 'string' ? args.reason.trim() : ''
        if (id === '') return 'action=skip 需要 question_id。'
        if (reason === '') return `action=skip 必须带 reason（跳过 ${id} 的理由）。跳过会被写进规格的阻塞项，必答项跳过仍会挡住 done。`
        const q = questionById(id)
        if (q === undefined) return `未知问题 id：${id}。可用 action=status 查看全部问题与进度。`
        const { state } = await loadOrInit(io, root, intake)
        const ctx = await loadContext(io, root)
        applySkip(state, id, reason)
        markAsked(state, id, new Date())
        const written = await writeSpec(io, root, state, ctx)
        await saveState(io, root, state)
        const echo = [
          `已跳过：${id}（理由：${reason}）`,
          q.required ? '⚠️ 这是必答项：跳过不会解除阻塞，done 仍会拒绝，直到你真正回答它。' : '非必答项，规格里会标注为未知。',
          `规格已刷新：${written.path}`,
        ]
        const next = nextQuestion(state, ctx)
        if (next === undefined) {
          const blockersNow = blockingRequired(state)
          echo.push('')
          echo.push(blockersNow.length === 0
            ? completionReport(state, written.path, [])
            : `还有必答缺口：${blockersNow.map(b => b.id).join('、')}——这些不能用 skip 过关。`)
          return echo.join('\n')
        }
        return questionCard(next, state, ctx, echo)
      }

      case 'status': {
        const { state, created } = await loadOrInit(io, root, intake)
        const ctx = await loadContext(io, root)
        const required = listRequired()
        const blockersNow = blockingRequired(state)
        const queue = questionQueue(state, ctx)
        const lines: string[] = []
        lines.push(created ? '（此前没有状态，已初始化一份新状态。）' : '追问现状')
        lines.push(`- 工作区：${root}`)
        lines.push(`- 阶段：${ctx.stage}${ctx.materials.found ? `；材料清单已读取（${ctx.materials.items.length} 项）` : '；未找到 00-管理/材料清单.md'}`)
        lines.push(`- 状态：${state.stage === 'done' ? '✅ 必答项已齐全' : '⏳ 进行中'}；最近更新 ${state.updatedAt}`)
        lines.push(`- 进度：${progressLine(state)}`)
        lines.push('')
        lines.push('必答项：')
        for (const q of required) {
          const rec = state.answers[q.id]
          const mark = rec === undefined
            ? (state.skipped.includes(q.id) ? '⏭️ 已跳过（仍阻塞）' : '⬜ 未答')
            : (rec.valid === false ? `⚠️ 已答但格式待修正（${rec.note ?? ''}）` : (rec.confirmed ? '✅ 已确认' : '🟡 材料推断待确认'))
          lines.push(`- ${q.id}（${q.section}）：${mark}`)
        }
        lines.push('')
        lines.push(`非必答项：${QUESTIONS.length - required.length} 个，已答 ${Object.keys(state.answers).length - required.filter(q => state.answers[q.id] !== undefined).length} 个`)
        lines.push(queue.length > 0 ? `待问队列（前 5）：${queue.slice(0, 5).map(q => q.id).join('、')}` : '待问队列：空')
        lines.push(`阻塞项（${blockersNow.length}）：${blockersNow.map(q => q.id).join('、') || '无'}`)
        lines.push('')
        lines.push(`规格位置：${state.specPath === '' ? specRel : state.specPath}`)
        lines.push('下一步：' + (queue.length > 0
          ? `thesis_intake action=ask 取下一个问题（当前该答：${queue[0]!.id}）`
          : (blockersNow.length > 0 ? 'thesis_intake action=answer question_id=<缺口 id> answer=<答案>' : 'thesis_intake action=done')))
        return lines.join('\n')
      }

      case 'spec': {
        const { state } = await loadOrInit(io, root, intake)
        const ctx = await loadContext(io, root)
        const written = await writeSpec(io, root, state, ctx)
        await saveState(io, root, state)
        const lines: string[] = []
        lines.push(`规格已重绘并落盘：${written.path}（${written.bytes} 字符）`)
        lines.push(`必答项：${progressLine(state)}`)
        lines.push(written.blockerIds.length > 0
          ? `阻塞项（${written.blockerIds.length}）：${written.blockerIds.join('、')}——规格里已显式标注为「未知（需补）」。`
          : '阻塞项：无。')
        const next = nextQuestion(state, ctx)
        if (next !== undefined) {
          lines.push('')
          lines.push(`继续追问：thesis_intake action=ask（下一个问题：${next.id}）`)
        } else if (written.blockerIds.length === 0) {
          lines.push('')
          lines.push('没有待问的问题了：可以 thesis_intake action=done 收尾。')
        }
        return lines.join('\n')
      }

      case 'done': {
        const { state } = await loadOrInit(io, root, intake)
        const ctx = await loadContext(io, root)
        const blockersNow = blockingRequired(state)
        if (blockersNow.length > 0) {
          const lines: string[] = []
          lines.push(`无法完成追问：还有 ${blockersNow.length} 个必答项没齐，规格不算收敛，不能进入下一阶段。`)
          lines.push('')
          for (const q of blockersNow) {
            const rec = state.answers[q.id]
            const why = rec === undefined
              ? (state.skipped.includes(q.id) ? `已跳过（${state.skipReasons[q.id] ?? '未给理由'}）——跳过不能代替回答` : '尚未回答')
              : `已答但格式不合格：${rec.note ?? '校验未通过'}`
            lines.push(`- ${q.id}（${q.section}）：${why}`)
            lines.push(`  问：${q.ask}`)
            lines.push(`  合格答案：${q.answerShape}`)
          }
          lines.push('')
          lines.push('下一步：逐个回答上面的问题（thesis_intake action=answer question_id=<id> answer=<答案>），再 action=done。')
          return lines.join('\n')
        }
        const transition = setStage(state, 'done')
        if (!transition.ok) return `无法完成追问：${transition.reason}`
        const written = await writeSpec(io, root, state, ctx)
        await saveState(io, root, state)
        const sections = new Set(listRequired().map(q => q.section))
        const lines: string[] = []
        lines.push('✅ 追问完成：必答项齐全，意图规格已收敛并落盘。')
        lines.push(`- 规格：${written.path}（${written.bytes} 字符）`)
        lines.push(`- 必答项：${listRequired().length} 项全部已答，覆盖分节：${[...sections].join('、')}`)
        lines.push(`- 已答问题总数：${Object.keys(state.answers).length}/${QUESTIONS.length}；跳过 ${state.skipped.length} 项${state.skipped.length > 0 ? `（${state.skipped.join('、')}）` : ''}`)
        lines.push(`- 材料感知：${ctx.materials.found ? `清单 ${ctx.materials.items.length} 项，其中 ${materialInsight(ctx.materials).autoAnswers.size} 项由材料直接回答（已请用户确认）` : '未找到材料清单，全部问题由用户回答'}`)
        lines.push('')
        lines.push('规格里的未知条目（来源列为「未知」或「材料推断（未确认）」）仍会保留，写作/检查前请优先补齐；如发现答案有误，重答对应问题即可自动刷新规格。')
        return lines.join('\n')
      }

      default: {
        return `未知 action：${action}。有效值：${INTAKE_ACTIONS.join(' | ')}。`
      }
    }
  } catch (error) {
    // 写盘/读盘/校验的内部错误必须**抛出去**：工具的返回值就是模型看到的全部信息，
    // 把异常渲染成一段「执行失败」的普通文本会让模型以为这次调用成功了，
    // 从而在状态并未落盘的情况下继续写作。宿主的错误渲染会带上可读原因。
    if (error instanceof Error) throw error
    throw new Error(`thesis_intake 执行失败（${action}）：${String(error)}`)
  }
}

/** 供其它模块/测试复用：一次裁剪后的待问队列（受 maxQuestions 限制）。 */
export function pendingQueue(state: IntakeState, ctx: IntakeContext, maxQuestions: number): IntakeQuestion[] {
  return clampQueue(questionQueue(state, ctx), maxQuestions)
}

// ---------------------------------------------------------------------------
// 装配：工具 + 斜杠命令
// ---------------------------------------------------------------------------

/**
 * 注册 `thesis_intake`（单个工具、7 个 action）。
 *
 * 工具定义走仓库统一的 `definePaperTool`（生产 = 宿主真实 `defineTool`，
 * 离线 = `shared/define-tool.ts` 的等价实现），因此本模块在测试环境里可加载。
 * 工作区根由 `findThesisRoot` 从会话 cwd 向上探测 `00-管理/进度台账.md`；
 * 找不到时工具返回明确指引（先 `thesis_init`），不抛裸异常。
 */
export function registerIntake(ctx: Context, options: { intake: IntakeSubOptions }): void {
  const definition = intakeToolDefinition(ctx.fs as never, options.intake, runIntake)
  ctx.tools.register(definePaperTool({
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    output: textOutput(),
    async execute(rawArgs, exec) {
      return await definition.execute(rawArgs as IntakeArgs, exec as unknown as IntakeExecLike)
    },
  }))
  registerIntakeCommand(ctx, options)
}

/** 命令执行上下文的最小面（宿主 `CommandInvocation` 在结构上满足它）。 */
export interface IntakeExecLike {
  readonly signal?: AbortSignal
  readonly agent?: {
    readonly session: {
      readonly header: {
        readonly cwd?: string
      }
    }
  }
}

/** 命令返回值（宿主 `CommandResult` 的形状）。 */
export interface IntakeCommandResult {
  readonly kind: 'success' | 'error'
  readonly text?: string
}

/** 把 `/thesis-intake` 的一行输入翻译成追问动作。 */
export function parseCommandInput(raw: string): IntakeArgs {
  const text = raw.trim()
  if (text === '') return { action: 'ask' }
  const [head, ...rest] = text.split(/\s+/)
  switch (head) {
    case 'start':
    case 'ask':
    case 'status':
    case 'spec':
    case 'done':
      return { action: head }
    case 'answer': {
      const [id, ...words] = rest
      return { action: 'answer', question_id: id ?? '', answer: words.join(' ') }
    }
    case 'skip': {
      const [id, ...words] = rest
      return { action: 'skip', question_id: id ?? '', reason: words.join(' ') }
    }
    default:
      // 不认识的第一个词：当作问题 id 的简写，等价于 answer（模型/人最常这么用）。
      return { action: 'answer', question_id: head ?? '', answer: rest.join(' ') }
  }
}

/**
 * 注册命令 `/thesis-intake`（命令名只允许 `[a-z][a-z0-9_-]*`）。
 *
 * 用法：`/thesis-intake` 取下一个问题；`/thesis-intake status|spec|done|start`；
 * `/thesis-intake answer school.name XX大学`；`/thesis-intake skip ref.samples 暂时没有`。
 * `ctx.commands` 不可用（未装配命令服务的宿主）时静默跳过，不影响工具能力。
 */
export function registerIntakeCommand(ctx: Context, options: { intake: IntakeSubOptions }): boolean {
  const commands = (ctx as { commands?: { register(definition: unknown): unknown } }).commands
  if (commands === undefined || typeof commands.register !== 'function') return false
  commands.register({
    name: 'thesis-intake',
    description: '逐题追问：材料到手后把模糊要求变成意图规格（一次一个问题）',
    input: { hint: 'answer <问题id> <答案>｜skip <问题id> <理由>｜status｜spec｜done（缺省取下一个问题）' },
    async handler(invocation: IntakeExecLike & { readonly rawInput?: string }): Promise<IntakeCommandResult> {
      const args = parseCommandInput(invocation.rawInput ?? '')
      const text = await runIntake(ctx.fs as never, options.intake, args, sessionCwd(invocation as never), invocation.signal)
      // 工具层已经把失败写成可读中文，这里统一按 success 返回（命令不做二次包装）。
      return { kind: 'success', text }
    },
  })
  return true
}
