/**
 * thesis_originality 的端到端测试（假 ctx.fs）：落盘路径、复测降幅、学校结果回填与返回摘要。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import { REPORT_REL, VERIFY_REPORT_REL, registerDedup, runDedup, collectCorpus, type DedupArgs } from '../src/dedup/index.ts'
import { compileParameterSchema } from '../src/shared/index.ts'
import type { SimilarityOptions } from '../src/config.ts'
import { FakeFs, WORKSPACE_CWD, makeWorkspace } from './dedup-fixtures.ts'

const SIMILARITY: SimilarityOptions = { shingle: 4, threshold: 0.3, minChars: 30 }

const NOTE_TEXT = '笔记摘录：本文提出的注意力机制通过计算查询向量与键向量的相似度来确定每个位置应该关注的信息，'
  + '并在 8 个数据集上完成了 1200 次实验，平均准确率提升 3.5 个百分点。\n'

const CHAPTER_ONE = `# 第 1 章 绪论

## 1.1 研究背景与意义

近年来，随着深度学习在自然语言处理领域的广泛应用，序列建模任务对模型表达能力提出了更高要求。长距离依赖的建模质量直接影响翻译、摘要与问答等下游任务的表现，而循环网络在长序列上的梯度传播存在明显缺陷，因此注意力结构逐渐成为主流选择。本节从任务需求出发，说明研究该问题的现实意义与工程价值，并给出本课题的边界与不做的事情。

本文提出的注意力机制通过计算查询向量与键向量的相似度来确定每个位置应该关注的信息，并在 8 个数据集上完成了 1200 次实验，平均准确率提升 3.5 个百分点，相关结论与已有工作保持一致。

为了验证上述机制的有效性，本文在三个公开语料上补充了消融实验，逐一记录每种配置下的准确率、召回率与响应时间。所有实验数据均来自真实运行，原始日志保存在 05-实验测试/结果 目录下，可复现、可追溯，不包含任何手工调整的数值。

## 1.2 本文主要工作

围绕上述问题，本文完成三项工作：其一，梳理注意力结构的计算流程并给出复杂度分析；其二，实现一个可配置的编码器模块并接入现有系统；其三，在真实数据上完成对比实验与失败案例分析，给出适用边界与后续改进方向。三项工作分别对应第四章的设计、第五章的实现与第六章的测试，形成可追溯的对应关系。

## 1.3 论文组织结构

全文共七章。第一章说明研究背景与主要工作；第二章介绍本系统真正用到的相关技术；第三章给出功能与非功能需求；第四章给出总体架构与模块设计；第五章说明关键实现；第六章给出测试环境、用例与结果分析；第七章总结不足并给出展望。
`

const CHAPTER_TWO = `# 第 2 章 相关技术

## 2.1 注意力机制

注意力机制最早用于机器翻译任务，其核心是用查询与键的相似度对值向量加权求和，从而捕捉长距离依赖关系。与循环网络逐步传递隐状态不同，注意力可以在常数跳数内建立任意两个位置之间的联系，代价是计算量与序列长度的平方成正比，因此工程实现中通常需要分块计算或稀疏化近似。

本章只介绍本系统真正用到的技术：自注意力编码器、残差连接与层归一化，并结合文献笔记说明各自的适用边界与代价。对于未被本系统采用的技术路线，本章不做展开，避免把相关技术章写成技术手册摘抄。

## 2.2 残差连接与层归一化

残差连接把输入直接加到子层输出上，使梯度可以沿恒等路径回传，从而支持更深的网络；层归一化则在特征维度上做标准化，缓解内部协变量偏移。两者组合使用可以显著提升训练稳定性，但会引入额外的参数与计算开销，需要结合显存预算权衡层数与隐藏维度。

## 2.3 本章小结

本章介绍的三项技术在实现层面相互配合：自注意力负责建模位置之间的关系，残差连接保证深层网络的梯度可回传，层归一化稳定训练过程。三者都是本系统实际使用的部件，后续第四章的模块设计将直接复用这里的划分方式，第五章给出对应的代码入口。
`

function workspace(): FakeFs {
  return makeWorkspace({
    '06-论文/章节/01-绪论.md': CHAPTER_ONE,
    '06-论文/章节/02-相关技术.md': CHAPTER_TWO,
    '02-文献/笔记/attention.md': NOTE_TEXT,
    '05-实验测试/结果/性能测试.md': '结果记录：响应时间 35 毫秒，吞吐量 1200 次每秒。\n',
  })
}

test('dedup 工具：scan 落盘 08-合规/降重报告.md 并返回有界摘要', async () => {
  const fs = workspace()
  const text = await runDedup(fs, WORKSPACE_CWD, { action: 'scan' }, SIMILARITY)
  const saved = fs.peek(`C:/thesis/${REPORT_REL}`)
  assert.ok(saved !== undefined, `未写入 ${REPORT_REL}`)
  assert.ok(saved!.includes('# 降重报告（本地相似度度量）'))
  assert.ok(saved!.includes('2026') || saved!.includes('T'))
  assert.ok(saved!.includes('shingle=4'))
  assert.ok(saved!.includes('不接入'))
  assert.ok(text.includes('正文段落'))
  assert.ok(text.includes('分级：high'))
  assert.ok(text.includes('Top 5 高风险段落'))
  assert.ok(text.includes('下一步建议'))
  assert.ok(text.includes(`报告已写入：${REPORT_REL}`))
  assert.ok(text.includes('加权重复率估算'))
  // 摘要必须有界（不把整份报告回灌给模型）。
  assert.ok(text.length < saved!.length)
})

test('dedup 工具：chapter 参数只扫描指定章，返回摘要给出该章命中', async () => {
  const fs = workspace()
  const text = await runDedup(fs, WORKSPACE_CWD, { action: 'scan', chapter: '01-绪论' }, SIMILARITY)
  assert.ok(text.includes('01-绪论'))
  const saved = fs.peek(`C:/thesis/${REPORT_REL}`)
  assert.ok(saved !== undefined)
  assert.ok(saved!.includes('06-论文/章节/01-绪论.md'))
  // 只扫描指定章：命中清单里不应出现其它章（语料标签允许列出，故按行判断）。
  const riskLines = saved!.split('\n').filter(line => line.startsWith('| ') && !line.startsWith('| #') && !line.startsWith('|---'))
  assert.ok(riskLines.length >= 1)
  assert.ok(riskLines.every(line => !line.includes('02-相关技术')), riskLines.join('\n'))
  assert.ok(!saved!.includes('**原文（02-相关技术'))
})

test('dedup 工具：verify 用 baseline 计算降幅并写 降重报告-复测.md', async () => {
  const fs = workspace()
  await runDedup(fs, WORKSPACE_CWD, { action: 'scan' }, SIMILARITY)
  const baselineText = fs.peek(`C:/thesis/${REPORT_REL}`)
  assert.ok(baselineText !== undefined)

  // 用户改写：把命中段落换成完全不同的表述（保留数字与结论）。
  fs.put('C:/thesis/06-论文/章节/01-绪论.md', `# 第 1 章 绪论

## 1.1 研究背景与意义

近年来，序列建模对模型表达能力的要求不断提高，长距离依赖成为该领域的核心难点之一。

该机制先用内积度量查询与键的匹配程度，再据此对值向量加权聚合；我们在 8 个公开语料上跑了 1200 轮实验，准确率平均提高 3.5 个百分点，全部数据来自 05-实验测试/结果。
`)

  const text = await runDedup(fs, WORKSPACE_CWD, { action: 'verify', baseline: REPORT_REL }, SIMILARITY)
  const verifySaved = fs.peek(`C:/thesis/${VERIFY_REPORT_REL}`)
  assert.ok(verifySaved !== undefined, `未写入 ${VERIFY_REPORT_REL}`)
  assert.ok(verifySaved!.includes('# 降重复测报告'))
  assert.ok(verifySaved!.includes('加权重复率'))
  assert.ok(verifySaved!.includes('个百分点'))
  assert.ok(verifySaved!.includes('口径：'))
  assert.ok(text.includes('复测完成'))
  assert.ok(text.includes('降幅：'))
  assert.ok(text.includes('结论：'))
})

test('dedup 工具：verify 缺 baseline 报告时给出可操作报错', async () => {
  const fs = workspace()
  await assert.rejects(
    () => runDedup(fs, WORKSPACE_CWD, { action: 'verify' }, SIMILARITY),
    /未找到 baseline 报告/,
  )
})

test('dedup 工具：report 把学校检测结果回填进报告', async () => {
  const fs = workspace()
  const args: DedupArgs = { action: 'report', detected_rate: 15, detected_system: '知网 PMLC' }
  const text = await runDedup(fs, WORKSPACE_CWD, args, SIMILARITY)
  const saved = fs.peek(`C:/thesis/${REPORT_REL}`)
  assert.ok(saved !== undefined)
  assert.ok(saved!.includes('检测重复率：15.0%（权威口径）'))
  assert.ok(saved!.includes('知网 PMLC'))
  assert.ok(saved!.includes('差距：'))
  assert.ok(text.includes('正文段落'))
})

test('dedup 工具：未知 action 与缺工作区都给出明确报错', async () => {
  const fs = workspace()
  await assert.rejects(() => runDedup(fs, WORKSPACE_CWD, { action: 'rewrite' }, SIMILARITY), /未知 action/)
  const empty = new FakeFs()
  await assert.rejects(() => runDedup(empty, WORKSPACE_CWD, { action: 'scan' }, SIMILARITY), /未找到论文工作区/)
})

test('dedup 工具：缺 action 不静默当成 scan（否则会意外覆盖报告）', async () => {
  const fs = workspace()
  await assert.rejects(
    () => runDedup(fs, WORKSPACE_CWD, {} as never, SIMILARITY),
    /action 必填/,
  )
  await assert.rejects(
    () => runDedup(fs, WORKSPACE_CWD, { action: '   ' }, SIMILARITY),
    /action 必填/,
  )
  // 缺 action 时不得产生任何报告文件（FakeFs 的路径基准与 WORKSPACE_CWD 同根）。
  const reportPath = 'C:/thesis/08-合规/降重报告.md'
  assert.equal(fs.peek(reportPath), undefined, '缺 action 时不得落盘报告')
})

test('dedup 工具：corpus 显式指定文件与目录都能被收集', async () => {
  const fs = workspace()
  const byDir = await collectCorpus(fs, 'C:/thesis', '02-文献/笔记', [], false)
  assert.equal(byDir.length, 1)
  assert.equal(byDir[0]!.file, '02-文献/笔记/attention.md')
  const byFile = await collectCorpus(fs, 'C:/thesis', '05-实验测试/结果/性能测试.md', [], false)
  assert.equal(byFile.length, 1)
  assert.ok(byFile[0]!.text.includes('35 毫秒'))
  const missing = await collectCorpus(fs, 'C:/thesis', '02-文献/不存在.md', [], false)
  assert.equal(missing.length, 0)
})

test('dedup 工具：缺省语料包含正文互查（各章整章作为参考语料）', async () => {
  const fs = workspace()
  const corpus = await collectCorpus(fs, 'C:/thesis', undefined, [], true)
  const files = corpus.map(entry => entry.file)
  assert.ok(files.includes('02-文献/笔记/attention.md'))
  assert.ok(files.includes('05-实验测试/结果/性能测试.md'))
  assert.ok(files.includes('06-论文/章节/01-绪论.md'))
  assert.ok(files.includes('06-论文/章节/02-相关技术.md'))
  const labels = corpus.map(entry => entry.label)
  assert.ok(labels.some(label => label.includes('正文互查')))
})

test('dedup 工具：未撰写章节在摘要里被明确提示', async () => {
  const fs = makeWorkspace({
    '06-论文/章节/01-绪论.md': CHAPTER_ONE,
    '02-文献/笔记/attention.md': NOTE_TEXT,
  })
  const text = await runDedup(fs, WORKSPACE_CWD, { action: 'scan' }, SIMILARITY)
  assert.ok(text.includes('未撰写/缺失章节未计入'), text.slice(0, 200))
  assert.ok(text.includes('02-相关技术'))
})

test('dedup 工具：单章扫描不与自身互查（段落包含于本章不算重复）', async () => {
  const fs = makeWorkspace({ '06-论文/章节/01-绪论.md': CHAPTER_ONE })
  const text = await runDedup(fs, WORKSPACE_CWD, { action: 'scan', chapter: '01-绪论' }, SIMILARITY)
  const saved = fs.peek(`C:/thesis/${REPORT_REL}`)
  assert.ok(saved !== undefined)
  // 语料为空 → 没有任何命中（若把本章自身当语料，每个段落都会是 100%）。
  assert.ok(text.includes('high 0 段'), text.slice(0, 300))
  assert.ok(saved!.includes('高风险 0 段'))
  assert.ok(!saved!.includes('正文互查'))
})

test('dedup 工具：registerDedup 用作者侧 DSL 注册 thesis_originality（参数可离线校验）', () => {
  const registered: unknown[] = []
  const ctx = {
    tools: { register: (definition: unknown) => { registered.push(definition); return () => {} } },
    fs: new FakeFs(),
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  } as unknown as Context
  registerDedup(ctx, { similarity: SIMILARITY })
  assert.equal(registered.length, 1)
  const definition = registered[0] as {
    name: string
    description: string
    parameters: { properties: Record<string, { type: string }>; required: string[] }
    output: { schema: { type: string }; render: (args: unknown, value: unknown) => { type: string; text: string }[] }
    execute: (args: unknown, exec: unknown) => Promise<unknown>
  }
  assert.equal(definition.name, 'thesis_originality')
  assert.ok(definition.description.includes('不接入知网'))
  assert.equal(definition.parameters.required.includes('action'), true)
  for (const name of ['action', 'corpus', 'chapter', 'baseline', 'detected_rate', 'detected_system']) {
    assert.ok(definition.parameters.properties[name] !== undefined, `缺少参数 ${name}`)
  }
  // 作者侧 DSL 的 `required: true` 注解必须被编译成 JSON Schema 的 required 数组。
  const compiled = compileParameterSchema({
    action: { type: 'string', required: true, description: 'x' },
    corpus: { type: 'string', description: 'y' },
  })
  assert.deepEqual(compiled.required, ['action'])
  const rendered = definition.output.render({}, '摘要文本')
  assert.equal(rendered[0]!.text, '摘要文本')
})
