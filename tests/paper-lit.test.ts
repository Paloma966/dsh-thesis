import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseArxivAtom, searchLiterature, type FetchLike, type LitRecord } from '../src/paper/lib/lit-api.ts'
import { bibKeyFor, buildBibtex, dedupeKey, parseBibDois, parseBibKeys } from '../src/paper/lib/bibtex.ts'
import { FakeFs } from './paper-fixtures.ts'

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const ARXIV_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>ArXiv Query</title>
  <entry>
    <id>http://arxiv.org/abs/1706.03762v7</id>
    <updated>2023-08-02T00:00:00Z</updated>
    <published>2017-06-12T17:57:34Z</published>
    <title>Attention Is All You Need</title>
    <summary>  The dominant sequence transduction models are based on &lt;em&gt;complex&lt;/em&gt; recurrent networks. </summary>
    <author><name>Ashish Vaswani</name></author>
    <author><name>Noam Shazeer</name></author>
    <doi>10.48550/arXiv.1706.03762</doi>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/1810.04805v2</id>
    <published>2018-10-11T17:58:19Z</published>
    <title>BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding</title>
    <summary>We introduce a new language representation model called BERT.</summary>
    <author><name>Jacob Devlin</name></author>
  </entry>
</feed>`

const SS_FIXTURE = {
  data: [
    {
      paperId: 'p1',
      title: 'Deep Learning for Image Recognition',
      authors: [{ name: 'Alice Zhang' }, { name: 'Bob Li' }],
      year: 2021,
      venue: 'IEEE Transactions on Pattern Analysis',
      abstract: 'A very long abstract. '.repeat(60),
      url: 'https://example.org/p1',
      citationCount: 120,
      externalIds: { DOI: '10.1000/p1' },
    },
    {
      paperId: 'p2',
      title: 'Small Object Detection Survey',
      authors: [{ name: 'Carol Wang' }],
      year: 2023,
      venue: '',
      url: 'https://arxiv.org/abs/2301.00001',
      citationCount: 3,
      externalIds: { ArXiv: '2301.00001' },
    },
  ],
}

const DBLP_FIXTURE = {
  result: {
    hits: {
      hit: {
        info: {
          title: 'Efficient Transformer Inference.',
          authors: { author: { text: 'Danny Chen' } },
          year: '2022',
          venue: 'ICLR',
          type: 'Conference and Workshop Papers',
          doi: '10.2000/dblp1',
          ee: 'https://example.org/dblp1',
        },
      },
    },
  },
}

const CROSSREF_FIXTURE = {
  message: {
    items: [
      {
        DOI: '10.3000/cr1',
        title: ['A Journal Paper on Systems'],
        author: [{ given: 'Eve', family: 'Zhao' }, { name: '赵六' }],
        issued: { 'date-parts': [[2020, 5, 1]] },
        'container-title': ['Journal of Systems'],
        type: 'journal-article',
        abstract: '<jats:p>A <jats:italic>great</jats:italic> paper.</jats:p>',
        URL: 'https://example.org/cr1',
      },
    ],
  },
}

function fakeFetch(routes: Record<string, () => unknown>): FetchLike {
  return async (url: string) => {
    for (const [key, make] of Object.entries(routes)) {
      if (url.includes(key)) {
        const value = make()
        if (value instanceof Error) throw value
        return new Response(typeof value === 'string' ? value : JSON.stringify(value), { status: 200 })
      }
    }
    throw new Error('unrouted url: ' + url)
  }
}

// ---------------------------------------------------------------------------
// 解析器
// ---------------------------------------------------------------------------

test('arXiv Atom：两条 entry、实体解码、作者列表、arxiv id', () => {
  const entries = parseArxivAtom(ARXIV_FIXTURE)
  assert.equal(entries.length, 2)
  assert.equal(entries[0]!.title, 'Attention Is All You Need')
  assert.equal(entries[0]!.authors.length, 2)
  assert.equal(entries[0]!.authors[1], 'Noam Shazeer')
  assert.equal(entries[0]!.arxivId, '1706.03762')
  assert.equal(entries[0]!.doi, '10.48550/arXiv.1706.03762')
  assert.ok(entries[0]!.summary.includes('complex') && !entries[0]!.summary.includes('<em>'))
  assert.equal(entries[1]!.arxivId, '1810.04805')
})

test('Semantic Scholar：字段映射、类型判定、摘要截断、id 稳定', async () => {
  const records = await searchLiterature(fakeFetch({ 'semanticscholar.org': () => SS_FIXTURE }), { query: 'x', source: 'semantic-scholar' })
  assert.equal(records.length, 2)
  const a = records[0]!
  assert.equal(a.title, 'Deep Learning for Image Recognition')
  assert.equal(a.type, 'article')
  assert.equal(a.doi, '10.1000/p1')
  assert.equal(a.citationCount, 120)
  assert.ok(a.abstract!.length <= 603)
  const b = records[1]!
  assert.equal(b.type, 'misc')
  assert.ok(b.url!.includes('arxiv.org'))
  // id 由 doi 派生且稳定
  const again = await searchLiterature(fakeFetch({ 'semanticscholar.org': () => SS_FIXTURE }), { query: 'x', source: 'semantic-scholar' })
  assert.equal(a.id, again[0]!.id)
})

test('DBLP：单作者对象归一化、类型映射、年份解析', async () => {
  const records = await searchLiterature(fakeFetch({ 'dblp.org': () => DBLP_FIXTURE }), { query: 'x', source: 'dblp' })
  assert.equal(records.length, 1)
  const r = records[0]!
  assert.deepEqual(r.authors, ['Danny Chen'])
  assert.equal(r.type, 'inproceedings')
  assert.equal(r.year, 2022)
  assert.equal(r.doi, '10.2000/dblp1')
})

test('Crossref：类型映射、作者拼接、日期解析、JATS 摘要去标签', async () => {
  const records = await searchLiterature(fakeFetch({ 'api.crossref.org': () => CROSSREF_FIXTURE }), { query: 'x', source: 'crossref' })
  assert.equal(records.length, 1)
  const r = records[0]!
  assert.equal(r.type, 'article')
  assert.deepEqual(r.authors, ['Eve Zhao', '赵六'])
  assert.equal(r.year, 2020)
  assert.equal(r.abstract, 'A great paper.')
})

test('降级链：首源失败换次源；全失败报错；source 指定单一来源', async () => {
  const failingSsem = fakeFetch({ 'semanticscholar.org': () => new Error('429'), 'dblp.org': () => DBLP_FIXTURE })
  const records = await searchLiterature(failingSsem, { query: 'x' })
  assert.equal(records[0]!.source, 'dblp')

  const allFail = fakeFetch({})
  await assert.rejects(searchLiterature(allFail, { query: 'x' }), /所有检索源均未返回结果/)

  // 指定 source=dblp 时不尝试其它源（semantic scholar 未被请求也不会报错）。
  const forced = await searchLiterature(fakeFetch({ 'dblp.org': () => DBLP_FIXTURE }), { query: 'x', source: 'dblp' })
  assert.equal(forced[0]!.source, 'dblp')
})

test('年份下限过滤（arXiv/Crossref 路径）', async () => {
  const records = await searchLiterature(
    fakeFetch({ 'export.arxiv.org': () => ARXIV_FIXTURE }),
    { query: 'x', source: 'arxiv', yearFrom: 2018 },
  )
  assert.equal(records.length, 1)
  assert.equal(records[0]!.title, 'BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding')
})

// ---------------------------------------------------------------------------
// BibTeX
// ---------------------------------------------------------------------------

test('bib key：英文首作者姓氏+年份+标题词；中文作者整体保留', () => {
  const en: LitRecord = { id: 'x', title: 'Attention Is All You Need', authors: ['Ashish Vaswani', 'Noam Shazeer'], year: 2017, venue: 'NeurIPS', type: 'inproceedings', source: 'test' }
  assert.equal(bibKeyFor(en), 'vaswani2017attention')
  const zh: LitRecord = { id: 'x', title: '基于深度学习的目标检测方法研究', authors: ['张三', '李四'], year: 2020, venue: '计算机学报', type: 'article', source: 'test' }
  assert.equal(bibKeyFor(zh), '张三2020基于深度')
})

test('bibtex：各类型条目与字段', () => {
  const article: LitRecord = { id: 'x', title: 'T', authors: ['A B'], year: 2020, venue: 'Journal', type: 'article', doi: '10.1/x', url: 'https://e.org', source: 't' }
  assert.match(buildBibtex(article).entry, /@article\{b2020t,\n  author = \{A B\},\n  title = \{T\},\n  journal = \{Journal\}/)
  assert.match(buildBibtex(article).entry, /doi = \{10\.1\/x\}/)
  const conf: LitRecord = { id: 'x', title: 'T', authors: ['A B'], year: 2020, venue: 'Conf', type: 'inproceedings', source: 't' }
  assert.match(buildBibtex(conf).entry, /@inproceedings\{b2020t,\n  author = \{A B\},\n  title = \{T\},\n  booktitle = \{Conf\}/)
  const misc: LitRecord = { id: 'x', title: 'T', authors: ['A B'], year: 2020, venue: 'arXiv preprint', type: 'misc', url: 'https://a.org', source: 't' }
  assert.match(buildBibtex(misc).entry, /@misc\{b2020t/)
})

test('bibtex：key 去重加后缀；keys/DOIs 解析', () => {
  assert.equal(dedupeKey('a', new Set(['a'])), 'aa')
  assert.equal(dedupeKey('a', new Set(['a', 'aa'])), 'ab')
  const bib = '@article{vaswani2017attention,\n  doi = {10.48550/arXiv.1706.03762}\n}\n@misc{x2020y,\n  doi = {10.2/Y}\n}'
  assert.deepEqual([...parseBibKeys(bib)].sort(), ['vaswani2017attention', 'x2020y'])
  assert.deepEqual([...parseBibDois(bib)].sort(), ['10.2/y', '10.48550/arxiv.1706.03762'])
})

// ---------------------------------------------------------------------------
// 全流程（FakeFs + fake fetch）
// ---------------------------------------------------------------------------

test('文献全流程：init→search→save→note', async () => {
  const fs = new FakeFs()
  const { runInit } = await import('../src/paper/tools/init.ts')
  const { runLitSearch, runLitSave, runLitNote } = await import('../src/paper/tools/lit.ts')
  await runInit(fs, { root: '/tmp/thesis-lit', git: false }, '/nonexistent')

  const fetchImpl = fakeFetch({ 'semanticscholar.org': () => SS_FIXTURE })
  const out = await runLitSearch(fs, { query: 'image recognition' }, '/tmp/thesis-lit', undefined, fetchImpl)
  assert.match(out, /命中 2 条/)
  const cache = JSON.parse(fs.peek('/tmp/thesis-lit/02-文献/.lit-cache.json')!)
  const ids = Object.keys(cache.records)
  assert.equal(ids.length, 2)
  const recordRow = fs.peek('/tmp/thesis-lit/02-文献/检索记录.md')!
  assert.match(recordRow, /\| 检索 \| semantic-scholar \| image recognition \| 2 \|/)

  // save：收录第一条
  const saveOut = await runLitSave(fs, { ids: [ids[0]!] }, '/tmp/thesis-lit')
  assert.match(saveOut, /本次收录 1\/1 条/)
  const bib = fs.peek('/tmp/thesis-lit/02-文献/refs.bib')!
  assert.match(bib, /@article\{zhang2021deep/)
  assert.match(bib, /doi = \{10\.1000\/p1\}/)
  const saveRowText = fs.peek('/tmp/thesis-lit/02-文献/检索记录.md')!
  assert.match(saveRowText, /\| 收录 \|/)

  // 重复收录被 DOI 去重跳过
  const again = await runLitSave(fs, { ids: [ids[0]!] }, '/tmp/thesis-lit')
  assert.match(again, /已在 refs.bib 中/)

  // 缓存外的 id 被拒绝（零假文献机制）
  const bogus = await runLitSave(fs, { ids: ['deadbeef'] }, '/tmp/thesis-lit')
  assert.match(bogus, /不在检索缓存中/)

  // note：按缓存 id 创建
  const noteOut = await runLitNote(fs, { ref: ids[0]! }, '/tmp/thesis-lit')
  assert.match(noteOut, /笔记骨架已创建/)
  const notePath = /02-文献[\\/]笔记[\\/][a-zA-Z0-9_.-]+\.md/.exec(noteOut)![0]
  const note = fs.peek('/tmp/thesis-lit/' + notePath)!
  assert.match(note, /Deep Learning for Image Recognition/)
  assert.match(note, /## 与我课题的关系/)

  // note：已存在拒绝覆盖；force 放行
  await assert.rejects(runLitNote(fs, { ref: ids[0]! }, '/tmp/thesis-lit'), /笔记已存在/)
  await runLitNote(fs, { ref: ids[0]!, force: true }, '/tmp/thesis-lit')

  // note：按 bib key 引用（缓存外路径）——先收录第二条再按其 key 建笔记
  const save2 = await runLitSave(fs, { ids: [ids[1]!] }, '/tmp/thesis-lit')
  assert.match(save2, /本次收录 1\/1 条/)
  const byKey = await runLitNote(fs, { ref: 'wang2023small' }, '/tmp/thesis-lit')
  assert.match(byKey, /笔记骨架已创建/)
  const note2 = fs.peek('/tmp/thesis-lit/02-文献/笔记/wang2023small.md')!
  assert.match(note2, /Small Object Detection Survey/)
})

test('search 在非工作区目录报错', async () => {
  const fs = new FakeFs()
  const { runLitSearch } = await import('../src/paper/tools/lit.ts')
  await assert.rejects(runLitSearch(fs, { query: 'x' }, '/tmp', undefined, fakeFetch({})), /未找到论文工作区/)
})

test('多源结果排序：按被引降序', async () => {
  const records = await searchLiterature(fakeFetch({ 'semanticscholar.org': () => SS_FIXTURE }), { query: 'x', source: 'semantic-scholar' })
  assert.equal(records[0]!.citationCount, 120)
  assert.equal(records[1]!.citationCount, 3)
})
