/**
 * `thesis_intake` 工具测试：用假 `ctx.fs` 验证 7 个 action 的返回内容与落盘结果。
 *
 * 覆盖验收点：start → ask → answer 循环；`maxQuestions` 上限生效；
 * 每次 answer 后规格自动刷新；`done` 在必答项未齐时拒绝并列出缺口；
 * 缺失工作区时给出指引而不是抛裸异常；返回内容有界且一次最多一个问题。
 *
 * @module dsh-thesis/tests/intake-tool
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { intakeToolDefinition, type IntakeArgs, type IntakeExec, type IntakeSubOptions } from '../src/intake/definitions.ts'
import { parseCommandInput, registerIntake, registerIntakeCommand, runIntake } from '../src/intake/index.ts'
import { listRequired } from '../src/intake/questions.ts'
import { parseState, STATE_REL } from '../src/intake/state.ts'
import { FakeFs, materialsMarkdown, ROOT, workspace } from './intake-fixtures.ts'

const OPTS: IntakeSubOptions = { maxQuestions: 12, specRel: '00-管理/意图规格.md' }
const SPEC_ABS = `${ROOT}/00-管理/意图规格.md`

/**
 * 假注册壳：`defineTool` / `ctx.tools.register` 是宿主运行时能力，
 * 本仓库编译期只有类型声明（不安装宿主包），所以这里复刻 `register.ts` 的注册
 * 与调用两行胶水；工具定义本身来自 `intakeToolDefinition`（与真实注册完全同源）。
 */
function fakeRegister(fs: FakeFs): { ctx: unknown; registered: string[]; call: (args: IntakeArgs) => Promise<string> } {
  const registered: string[] = []
  const definition = intakeToolDefinition(fs, OPTS, runIntake)
  const ctx = {
    fs,
    tools: {
      register(def: unknown) {
        registered.push((def as { name: string }).name)
        return () => {}
      },
    },
  }
  const exec: IntakeExec = { agent: { session: { header: { cwd: ROOT } } } }
  return {
    ctx,
    registered,
    call: async args => {
      // 复刻 register.ts 的一行胶水：注册即登记工具名，execute 委托给同源定义。
      ctx.tools.register(definition)
      return await definition.execute(args, exec)
    },
  }
}

/** 数一段文本里有几个「问：」，用于验证「一次最多一个问题」。 */
function countQuestions(text: string): number {
  return (text.match(/【下一个问题】/g) ?? []).length
}

/**
 * 复刻工具 execute 的参数搬运：`session_asked` 是参数对象里的字段，
 * execute 会把它作为第 6 个位置参数传给 `runIntake`。
 */
async function callIntake(fs: FakeFs, intake: IntakeSubOptions, args: IntakeArgs): Promise<string> {
  const sessionAsked = typeof args.session_asked === 'number' ? args.session_asked : 0
  return await runIntake(fs, intake, args, ROOT, undefined, sessionAsked)
}

/** 各必答项的「合格答案」示例：形状与问题卡的 answerShape 对齐，便于走完整闭环。 */
const VALID_ANSWERS: Record<string, string> = {
  'school.name': 'XX大学 计算机学院 软件工程',
  'school.degree': '本科（工学学士）',
  'school.template': '00-管理/学校模板.docx',
  'school.rule.ai': '有：学校《学术道德规范》要求 AI 生成内容须标注并不得替代本人独立完成的论证；出处：教务处 2025 年通知',
  'topic.title': '基于知识图谱的校园问答系统设计与实现',
  'deliver.timeline': '开题 2026-01-10，中期 2026-03-20，查重 2026-05-01，答辩 2026-05-20',
  'data.real': '有：测试结果在 06-论文/assets/测试结果.csv',
  'ref.format': 'GB/T 7714-2015 顺序编码制（上标数字）',
}

/** 仍未在表里的问题用一句通用答案兜底（非必答项与将来新增项）。 */
const FALLBACK_ANSWER = '测试用答案：已确认（本条不影响必答项校验）'

/** 取某个问题的合格示例答案。 */
function answerFor(id: string): string {
  return VALID_ANSWERS[id] ?? FALLBACK_ANSWER
}

async function answerAllRequired(fs: FakeFs, maxQuestions = 40): Promise<string> {
  let last = ''
  for (let i = 0; i < maxQuestions; i += 1) {
    last = await callIntake(fs, OPTS, { action: 'ask' })
    const id = /【下一个问题】(\S+?) ·/.exec(last)?.[1]
    if (id === undefined) return last
    last = await callIntake(fs, OPTS, { action: 'answer', question_id: id, answer: answerFor(id) })
  }
  return last
}

test('工具定义与注册：名字、action 参数、execute 走真实执行层', async () => {
  const fs = workspace({})
  const { registered, call } = fakeRegister(fs)
  const definition = intakeToolDefinition(fs, OPTS, runIntake)
  assert.equal(definition.name, 'thesis_intake')
  const params = definition.parameters as Record<string, { required?: boolean }>
  assert.equal(params.action?.required, true)
  assert.deepEqual(Object.keys(params).sort(), ['action', 'answer', 'question_id', 'reason', 'session_asked'])

  // 工具 execute 与 runIntake 同源：用假 ctx.fs 真的走一遍 start。
  const out = await call({ action: 'start' })
  assert.deepEqual(registered, ['thesis_intake'])
  assert.match(out, /已初始化追问状态/)
  assert.equal(countQuestions(out), 1)
  assert.ok(fs.files.has(SPEC_ABS))
})

test('缺失工作区时给指引，不抛裸异常', async () => {
  const fs = new FakeFs()
  const out = await runIntake(fs, OPTS, { action: 'start' }, '/nowhere')
  assert.match(out, /未找到论文工作区/)
  assert.match(out, /thesis_init/)
})

test('未知 action 与参数缺失都被明确拒绝', async () => {
  const fs = workspace({})
  assert.match(await runIntake(fs, OPTS, { action: '乱写' }, ROOT), /未知 action/)
  assert.match(await runIntake(fs, OPTS, { action: 'answer' }, ROOT), /需要 question_id/)
  assert.match(await runIntake(fs, OPTS, { action: 'answer', question_id: 'school.name' }, ROOT), /answer/)
  assert.match(await runIntake(fs, OPTS, { action: 'answer', question_id: '不存在的问题', answer: 'x' }, ROOT), /未知问题 id/)
  assert.match(await runIntake(fs, OPTS, { action: 'skip', question_id: 'school.name' }, ROOT), /必须带 reason/)
  assert.match(await runIntake(fs, OPTS, { action: 'skip', question_id: '不存在', reason: '懒得答' }, ROOT), /未知问题 id/)
})

test('start → ask → answer 循环：一次一个问题，规格自动刷新', async () => {
  const fs = workspace({ stage: 1 })
  const start = await runIntake(fs, OPTS, { action: 'start' }, ROOT)
  assert.match(start, /已初始化追问状态/)
  assert.equal(countQuestions(start), 1, 'start 只允许返回一个问题')
  for (const field of ['问：', '为什么问：', '影响产出：', '合格答案：']) {
    assert.ok(start.includes(field), `问题卡缺少「${field}」`)
  }
  assert.ok(fs.files.has(SPEC_ABS), 'start 必须落盘规格')
  assert.ok(fs.files.has(`${ROOT}/${STATE_REL}`), 'start 必须落盘状态')

  const id = /【下一个问题】(\S+?) ·/.exec(start)![1]!
  const answered = await runIntake(fs, OPTS, { action: 'answer', question_id: id, answer: 'XX大学 计算机学院 软件工程' }, ROOT)
  assert.ok(answered.includes(`已记录：${id} =`), `回答回执必须回显问题 id：${answered.split('\n')[0]}`)
  assert.match(answered, /规格已刷新/)
  assert.equal(countQuestions(answered), 1, 'answer 也只允许返回一个问题')

  const state = parseState(fs.files.get(`${ROOT}/${STATE_REL}`)!)
  assert.equal(state.answers[id]?.value, 'XX大学 计算机学院 软件工程')
  assert.equal(state.answers[id]?.confirmed, true)
  assert.ok(state.askedIds.includes(id), '已回答的问题要记进 askedIds')
  assert.ok(fs.files.get(SPEC_ABS)!.includes('XX大学 计算机学院 软件工程'), '规格必须包含最新答案')
})

test('材料清单里的学校模板：不再重复问，改为待确认并写回来源', async () => {
  const fs = workspace({
    stage: 2,
    materials: materialsMarkdown([{ file: '01-材料/学校论文格式模板.docx', kind: '学校模板' }]),
  })
  const out = await runIntake(fs, OPTS, { action: 'start' }, ROOT)
  assert.equal(countQuestions(out), 1)
  assert.match(out, /【下一个问题】school\.template/)
  assert.match(out, /材料里已经有答案了/)
  assert.match(out, /01-材料\/学校论文格式模板\.docx/)
  assert.match(out, /请确认这条信息对不对/)

  const answered = await runIntake(fs, OPTS, { action: 'answer', question_id: 'school.template', answer: '对' }, ROOT)
  assert.match(answered, /已确认（来源：材料推断）/)
  const state = parseState(fs.files.get(`${ROOT}/${STATE_REL}`)!)
  assert.equal(state.answers['school.template']?.source, 'materials')
  assert.equal(state.answers['school.template']?.confirmed, true)
  // 材料已覆盖的问题不会在后续队列里重复出现。
  const status = await runIntake(fs, OPTS, { action: 'status' }, ROOT)
  assert.ok(!/待问队列（前 5）：[^]*school\.template/.test(status))
})

test('maxQuestions 上限生效：达到上限就停下并给出续问指引', async () => {
  const fs = workspace({})
  const opts: IntakeSubOptions = { maxQuestions: 2, specRel: '00-管理/意图规格.md' }
  const a = await callIntake(fs, opts, { action: 'ask' })
  assert.match(a, /第 1\/2 个问题/)
  const id = /【下一个问题】(\S+?) ·/.exec(a)![1]!
  await callIntake(fs, opts, { action: 'answer', question_id: id, answer: answerFor(id) })
  const b = await callIntake(fs, opts, { action: 'ask', session_asked: 1 })
  assert.match(b, /第 2\/2 个问题/)
  const capped = await callIntake(fs, opts, { action: 'ask', session_asked: 2 })
  assert.equal(countQuestions(capped), 0, '达到上限后不得再抛问题')
  assert.match(capped, /maxQuestions=2/)
  assert.match(capped, /还剩 \d+ 个可问的问题/)
})

test('validate 生效但不阻塞：格式不合格仍记录并提示，必答项卡住 done', async () => {
  const fs = workspace({})
  await runIntake(fs, OPTS, { action: 'start' }, ROOT)
  const out = await runIntake(fs, OPTS, { action: 'answer', question_id: 'school.name', answer: 'X' }, ROOT)
  assert.match(out, /格式提醒/)
  const state = parseState(fs.files.get(`${ROOT}/${STATE_REL}`)!)
  assert.equal(state.answers['school.name']?.valid, false)
  assert.equal(state.answers['school.name']?.value, 'X', '原样记录，不替用户改写')

  const done = await runIntake(fs, OPTS, { action: 'done' }, ROOT)
  assert.match(done, /无法完成追问/)
  assert.match(done, /school\.name/)
  assert.match(done, /格式不合格/)
  assert.match(done, /合格答案：/)
})

test('done 在必答项未齐时拒绝并列出缺口；齐全后标记阶段完成', async () => {
  const fs = workspace({})
  const rejected = await runIntake(fs, OPTS, { action: 'done' }, ROOT)
  assert.match(rejected, /无法完成追问/)
  assert.match(rejected, /school\.name/)
  for (const q of listRequired()) {
    assert.ok(rejected.includes(q.id), `缺口清单必须包含 ${q.id}`)
  }

  // 逐个回答必答项直到 done 通过（用合格答案，走完整闭环）。
  let last = ''
  for (let i = 0; i < 40; i += 1) {
    const ask = await callIntake(fs, OPTS, { action: 'ask' })
    const id = /【下一个问题】(\S+?) ·/.exec(ask)?.[1]
    if (id === undefined) break
    last = await callIntake(fs, OPTS, { action: 'answer', question_id: id, answer: answerFor(id) })
  }
  const done = await runIntake(fs, OPTS, { action: 'done' }, ROOT)
  assert.match(done, /追问完成/)
  assert.match(done, /00-管理\/意图规格\.md/)
  const state = parseState(fs.files.get(`${ROOT}/${STATE_REL}`)!)
  assert.equal(state.stage, 'done')
  assert.ok(last.length > 0)
})

test('skip 写进状态与规格，必答项跳过仍挡 done', async () => {
  const fs = workspace({})
  await runIntake(fs, OPTS, { action: 'start' }, ROOT)
  const out = await runIntake(fs, OPTS, { action: 'skip', question_id: 'scope.core', reason: '还没想清楚' }, ROOT)
  assert.match(out, /已跳过：scope\.core/)
  assert.match(out, /规格已刷新/)
  const state = parseState(fs.files.get(`${ROOT}/${STATE_REL}`)!)
  assert.ok(state.skipped.includes('scope.core'))
  assert.equal(state.skipReasons['scope.core'], '还没想清楚')
  assert.ok(fs.files.get(SPEC_ABS)!.includes('已跳过：还没想清楚'))

  const skipRequired = await runIntake(fs, OPTS, { action: 'skip', question_id: 'data.real', reason: '数据还没跑' }, ROOT)
  assert.match(skipRequired, /必答项/)
  const done = await runIntake(fs, OPTS, { action: 'done' }, ROOT)
  assert.match(done, /data\.real/)
  assert.match(done, /跳过不能代替回答/)
})

test('spec 与 status：路径、阻塞项、断点续问信息都齐全', async () => {
  const fs = workspace({ stage: 4 })
  await runIntake(fs, OPTS, { action: 'start' }, ROOT)
  const spec = await runIntake(fs, OPTS, { action: 'spec' }, ROOT)
  assert.match(spec, /规格已重绘并落盘：00-管理\/意图规格\.md/)
  assert.match(spec, /阻塞项（\d+）/)
  assert.match(spec, /school\.name/)

  const status = await runIntake(fs, OPTS, { action: 'status' }, ROOT)
  assert.match(status, /追问现状/)
  assert.match(status, /必答项 \d+\/\d+ 已答/)
  assert.match(status, /系统设计/, '阶段应来自台账的 currentStage=4')
  assert.match(status, /下一个问题/)
})

test('断点续问：新会话读回状态后继续问下一个（不重头开始）', async () => {
  const fs = workspace({})
  const start = await runIntake(fs, OPTS, { action: 'start' }, ROOT)
  const id = /【下一个问题】(\S+?) ·/.exec(start)![1]!
  await runIntake(fs, OPTS, { action: 'answer', question_id: id, answer: 'XX大学 计算机学院 软件工程' }, ROOT)

  // 模拟新会话：同一个工作区、全新一次调用。
  const resumed = await runIntake(fs, OPTS, { action: 'start' }, ROOT)
  assert.match(resumed, /已读取既有追问状态（可断点续问）/)
  const nextId = /【下一个问题】(\S+?) ·/.exec(resumed)?.[1]
  assert.notEqual(nextId, id, '不应重复问已回答的问题')
  assert.ok(nextId !== undefined)
})

test('状态损坏时抛出可读错误，而不是静默重置或返回"成功"文本', async () => {
  const fs = workspace({})
  fs.files.set(`${ROOT}/${STATE_REL}`, '{ 坏掉的 JSON')
  await assert.rejects(
    runIntake(fs, OPTS, { action: 'start' }, ROOT),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      assert.match(message, /不是合法 JSON/, '错误必须说明状态文件损坏的原因')
      return true
    },
  )
  assert.equal(fs.files.get(`${ROOT}/${STATE_REL}`), '{ 坏掉的 JSON', '损坏的状态文件不得被覆盖')
})

test('状态文件读不出来（非"不存在"）时抛错，绝不覆盖用户已答内容', async () => {
  const fs = workspace({})
  fs.files.set(`${ROOT}/${STATE_REL}`, '{"version":1}')
  // 模拟权限/IO 故障：读抛非 ENOENT 错误，写必须一次都不发生。
  const originalRead = fs.readText.bind(fs)
  let writes = 0
  const originalWrite = fs.writeText.bind(fs)
  fs.readText = async (target: { displayPath: string }, signal?: AbortSignal) => {
    if (target.displayPath.replace(/\\/g, '/').endsWith(STATE_REL)) {
      const failure = new Error('EACCES: permission denied') as Error & { code: string }
      failure.code = 'EACCES'
      throw failure
    }
    return await originalRead(target, signal)
  }
  fs.writeText = async (...args: Parameters<typeof originalWrite>) => {
    writes += 1
    return await originalWrite(...args)
  }
  await assert.rejects(runIntake(fs, OPTS, { action: 'start' }, ROOT), /读不出来|EACCES/)
  assert.equal(writes, 0, '读失败时不得发生任何写盘（否则会用默认态覆盖用户答案）')
})

test('规模检查：一次返回有界（不会把问题库全倒出来）', async () => {
  const fs = workspace({})
  const out = await runIntake(fs, OPTS, { action: 'start' }, ROOT)
  assert.equal(countQuestions(out), 1)
  assert.ok(out.length < 1600, `单次返回过长（${out.length} 字符）`)
})

test('完整走一遍：全部必答项答完后 done 通过，规格里无阻塞项', async () => {
  const fs = workspace({})
  await answerAllRequired(fs)
  const state = parseState(fs.files.get(`${ROOT}/${STATE_REL}`)!)
  assert.ok(Object.keys(state.answers).length >= listRequired().length)
  const out = await runIntake(fs, OPTS, { action: 'done' }, ROOT)
  assert.match(out, /追问完成/)
  const spec = fs.files.get(SPEC_ABS)!
  assert.match(spec, /无。全部必答项已齐全。/, '规格的阻塞项一节应为空')
  assert.match(spec, /已读取|未找到/, '材料感知状态必须写进规格')
})

test('registerIntake：注册 thesis_intake 与 /thesis-intake 命令（命令不可用时静默跳过）', () => {
  const fs = workspace({})
  const tools: string[] = []
  const commands: string[] = []
  const ctx = {
    fs,
    tools: { register: (def: unknown) => { tools.push((def as { name: string }).name); return () => {} } },
    commands: { register: (def: unknown) => { commands.push((def as { name: string }).name); return () => {} } },
  }
  registerIntake(ctx as never, { intake: OPTS })
  assert.deepEqual(tools, ['thesis_intake'])
  assert.deepEqual(commands, ['thesis-intake'])

  // 没有命令服务的宿主：工具照常注册，命令静默跳过，不抛异常。
  const toolsOnly = { fs, tools: { register: () => () => {} } }
  assert.doesNotThrow(() => registerIntake(toolsOnly as never, { intake: OPTS }))
  assert.equal(registerIntakeCommand(toolsOnly as never, { intake: OPTS }), false)
})

test('/thesis-intake 命令：输入解析 + handler 用会话 cwd 驱动同一执行层', async () => {
  assert.deepEqual(parseCommandInput(''), { action: 'ask' })
  assert.deepEqual(parseCommandInput('  status '), { action: 'status' })
  assert.deepEqual(parseCommandInput('done'), { action: 'done' })
  assert.deepEqual(parseCommandInput('answer school.name XX大学 计算机学院'), { action: 'answer', question_id: 'school.name', answer: 'XX大学 计算机学院' })
  assert.deepEqual(parseCommandInput('skip ref.samples 暂时没有'), { action: 'skip', question_id: 'ref.samples', reason: '暂时没有' })
  // 只写问题 id + 答案的简写，等价于 answer。
  assert.deepEqual(parseCommandInput('scope.core 做校园问答'), { action: 'answer', question_id: 'scope.core', answer: '做校园问答' })

  const fs = workspace({})
  const commands: Array<{ name: string; handler: (inv: unknown) => Promise<{ kind: string; text?: string }> }> = []
  const ctx = {
    fs,
    tools: { register: () => () => {} },
    commands: { register: (def: unknown) => { commands.push(def as never); return () => {} } },
  }
  registerIntake(ctx as never, { intake: OPTS })
  const handler = commands[0]!.handler
  const out = await handler({ rawInput: '', signal: undefined, agent: { session: { header: { cwd: ROOT } } } })
  assert.equal(out.kind, 'success')
  assert.equal(countQuestions(out.text ?? ''), 1, '命令同样一次只问一个问题')
  assert.match(out.text ?? '', /第 1\/12 个问题/, '缺省输入等价于取下一个问题')
  assert.ok(fs.files.has(`${ROOT}/${STATE_REL}`), '命令也会初始化状态')

  const started = await handler({ rawInput: 'start', signal: undefined, agent: { session: { header: { cwd: ROOT } } } })
  assert.match(started.text ?? '', /已读取既有追问状态（可断点续问）/)
})
