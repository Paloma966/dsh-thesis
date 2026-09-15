/**
 * 真实网络端到端（不属于单元测试套件，手动运行）：
 *   node tests/e2e-lit-real.mjs
 *
 * 用真实磁盘 + 真实学术 API，跑完整文献流程：
 * init → thesis_lit_search（真实检索）→ save（真实入库）→ note。
 * 验证"零假文献"机制在真实世界的表现（每条记录带真实 DOI/URL）。
 */

import { mkdir, readFile, rm, writeFile, readdir } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { tmpdir } from 'node:os'
import { runInit } from '../../lib/paper/tools/init.js'
import { runLitSearch, runLitSave, runLitNote } from '../../lib/paper/tools/lit.js'

// 真实网络端到端：工作区建在系统临时目录下（跨平台）。
const root = join(tmpdir(), `dsh-thesis-lit-e2e-${process.pid}`)

const realFs = {
  async resolve(path, opts) {
    const p = opts?.cwd && !isAbsolute(path) ? join(opts.cwd, path) : path
    return { displayPath: p }
  },
  async readText(target) {
    return await readFile(target.displayPath, 'utf8')
  },
  async writeText(target, content) {
    await mkdir(dirname(target.displayPath), { recursive: true })
    await writeFile(target.displayPath, content, 'utf8')
    return { version: 1 }
  },
  async listDir(target) {
    const entries = await readdir(target.displayPath, { withFileTypes: true })
    return entries.map(e => ({ name: e.name, isDirectory: e.isDirectory() }))
  },
  async stat(target) {
    throw new Error('not needed')
  },
}

const checks = []
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

try {
  await rm(root, { recursive: true, force: true })
  await runInit(realFs, { root, title: '文献端到端', git: false }, join(process.cwd(), 'skills'))

  // 1. 真实检索（默认降级链，预期 Semantic Scholar 命中）
  const t0 = Date.now()
  const out = await runLitSearch(realFs, { query: 'attention is all you need', limit: 5 }, root, undefined, fetch)
  console.log(`\n[检索] ${Date.now() - t0}ms\n${out.split('\n').slice(0, 14).join('\n')}\n`)
  check('真实检索返回 ≥1 条', /命中 [1-9]/.test(out))

  const cache = JSON.parse(await readFile(join(root, '02-文献/.lit-cache.json'), 'utf8'))
  const ids = Object.keys(cache.records)
  check('缓存含真实记录', ids.length >= 1)
  const sample = cache.records[ids[0]]
  check('记录带真实 DOI 或 URL', sample.doi !== undefined || sample.url !== undefined, `${sample.title} → ${sample.doi ?? sample.url}`)

  const audit = await readFile(join(root, '02-文献/检索记录.md'), 'utf8')
  check('检索审计行落盘', /\| 检索 \|/.test(audit))

  // 2. 收录（真实入库）
  const saveOut = await runLitSave(realFs, { ids }, root)
  console.log(`\n[收录]\n${saveOut}\n`)
  check('save 收录 ≥1 条', /✓/.test(saveOut))
  const bib = await readFile(join(root, '02-文献/refs.bib'), 'utf8')
  check('refs.bib 含 @ 条目与 DOI', /@(article|inproceedings|misc)\{/.test(bib) && /doi = \{10\./.test(bib))

  // 重复收录 → DOI 去重
  const again = await runLitSave(realFs, { ids }, root)
  check('重复收录被 DOI 去重', /已在 refs\.bib 中/.test(again))

  // 3. 笔记
  const noteOut = await runLitNote(realFs, { ref: ids[0] }, root)
  console.log(`\n[笔记]\n${noteOut}\n`)
  check('笔记骨架生成', /笔记骨架已创建/.test(noteOut))

  // 4. 指定单一来源（arXiv）
  const arxiv = await runLitSearch(realFs, { query: 'transformers', source: 'arxiv', limit: 3 }, root, undefined, fetch)
  check('arXiv 单源检索', /来源：arxiv/.test(arxiv), arxiv.split('\n')[0])

  // 5. 伪造 id 被拒（零假文献机制在真实流程中生效）
  const bogus = await runLitSave(realFs, { ids: ['ffffffffffffffff'] }, root)
  check('伪造 id 被拒', /不在检索缓存中/.test(bogus))
} finally {
  await rm(root, { recursive: true, force: true })
}

const failed = checks.filter(c => !c.ok)
console.log(`\n结果：${checks.length - failed.length}/${checks.length} 通过`)
process.exit(failed.length === 0 ? 0 : 1)
