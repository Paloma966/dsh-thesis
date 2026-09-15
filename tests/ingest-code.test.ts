/**
 * 代码结构摘要（`src/ingest/code.ts`）的单元测试。
 *
 * 这些用例守住两件事：① 语言/清单识别不漏不多；② 摘要只报"检出的结构信号"，
 * 不假装完整解析——所以断言的是具体声明名与行号，而不是"看起来差不多"。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_DECLARATIONS_PER_FILE,
  MAX_SCAN_LINES,
  codeLanguageOf,
  detectTechStack,
  isManifestFile,
  renderProjectSummary,
  summarizeSource,
} from '../src/ingest/code.ts'

test('语言识别：常见源码扩展名，非源码返回 undefined', () => {
  assert.equal(codeLanguageOf('src/a.ts'), 'typescript')
  assert.equal(codeLanguageOf('src\\a.tsx'), 'typescript')
  assert.equal(codeLanguageOf('main.py'), 'python')
  assert.equal(codeLanguageOf('App.java'), 'java')
  assert.equal(codeLanguageOf('server.go'), 'go')
  assert.equal(codeLanguageOf('lib.rs'), 'rust')
  assert.equal(codeLanguageOf('schema.sql'), 'sql')
  assert.equal(codeLanguageOf('styles.css'), 'css')
  assert.equal(codeLanguageOf('README.md'), undefined)
  assert.equal(codeLanguageOf('refs.bib'), undefined)
  assert.equal(codeLanguageOf('Makefile'), undefined)
  assert.equal(codeLanguageOf('.gitignore'), undefined)
})

test('清单文件识别', () => {
  assert.equal(isManifestFile('package.json'), true)
  assert.equal(isManifestFile('backend/requirements.txt'), true)
  assert.equal(isManifestFile('go.mod'), true)
  assert.equal(isManifestFile('pom.xml'), true)
  assert.equal(isManifestFile('src/package.json.bak'), false)
  assert.equal(isManifestFile('src/index.ts'), false)
})

test('TypeScript：检出函数/类/接口/箭头常量/路由，且统计注释与空行', () => {
  const source = [
    '// 模块入口',
    "import { x } from './x.ts'",
    '',
    'export interface Options { a: number }',
    'export type Id = string',
    'export enum Kind { A, B }',
    '',
    'export class Service {',
    '  // 内部方法不算顶层声明',
    '}',
    '',
    'export async function run(a: number): Promise<void> {',
    '}',
    '',
    'export const make = (x: number) => x',
    '',
    "app.get('/api/books', handler)",
  ].join('\n')

  const summary = summarizeSource('src/service.ts', source)
  assert.equal(summary.language, 'typescript')
  assert.equal(summary.lines, 17)
  assert.equal(summary.blankLines, 5)
  assert.equal(summary.commentLines, 2)
  assert.equal(summary.truncated, false)
  const found = summary.declarations.map(d => `${d.kind}:${d.name}`)
  assert.deepEqual(found, [
    'interface:Options',
    'type:Id',
    'enum:Kind',
    'class:Service',
    'function:run',
    'const:make',
    'route:/api/books',
  ])
  const run = summary.declarations.find(d => d.name === 'run')!
  assert.equal(run.line, 12, '行号必须在原文件里对得上')
})

test('Python / Java / Go / SQL：各自的结构信号', () => {
  const python = summarizeSource('app.py', [
    'import os',
    '',
    'class User:',
    '    def save(self):',
    '        pass',
    '',
    "def main():",
    '    pass',
    '',
    "@app.route('/login')",
    'def login():',
    '    pass',
  ].join('\n'))
  assert.deepEqual(python.declarations.map(d => `${d.kind}:${d.name}`), [
    'class:User',
    'function:save',
    'function:main',
    'route:/login',
    'function:login',
  ])

  const java = summarizeSource('UserService.java', [
    'public class UserService {',
    '    public User findById(Long id) {',
    '    }',
    '}',
  ].join('\n'))
  assert.ok(java.declarations.some(d => d.kind === 'class' && d.name === 'UserService'))
  assert.ok(java.declarations.some(d => d.kind === 'method' && d.name === 'findById'))

  const go = summarizeSource('main.go', [
    'package main',
    '',
    'type Server struct {',
    '}',
    '',
    'func (s *Server) Start() error {',
    '}',
  ].join('\n'))
  assert.ok(go.declarations.some(d => d.kind === 'struct' && d.name === 'Server'))
  assert.ok(go.declarations.some(d => d.kind === 'function' && d.name === 'Start'))

  const sql = summarizeSource('schema.sql', [
    '-- 用户表',
    'CREATE TABLE IF NOT EXISTS users (',
    '  id INTEGER PRIMARY KEY',
    ');',
    'CREATE VIEW active_users AS SELECT * FROM users;',
  ].join('\n'))
  assert.equal(sql.commentLines, 1)
  assert.ok(sql.declarations.some(d => d.kind === 'table' && d.name === 'users'))
  assert.ok(sql.declarations.some(d => d.kind === 'view' && d.name === 'active_users'))
})

test('声明的去重与数量上限', () => {
  const repeated = ['export function same() {}', 'export function same() {}'].join('\n')
  assert.equal(summarizeSource('a.ts', repeated).declarations.length, 1, '同名同类只记一次')

  const many = Array.from({ length: MAX_DECLARATIONS_PER_FILE + 20 }, (_v, i) => `export function fn${i}() {}`).join('\n')
  assert.equal(summarizeSource('b.ts', many).declarations.length, MAX_DECLARATIONS_PER_FILE)
})

test('超大文件被截断扫描并标记（不静默假装完整）', () => {
  const huge = Array.from({ length: MAX_SCAN_LINES + 100 }, () => 'const x = 1').join('\n')
  const summary = summarizeSource('huge.ts', huge)
  assert.equal(summary.truncated, true)
  assert.equal(summary.lines, MAX_SCAN_LINES + 100, '总行数仍如实报告')
})

test('技术栈推断：依赖清单里检出名字并给出证据文件', () => {
  const stack = detectTechStack({
    'package.json': '{"dependencies":{"react":"^18","express":"^4"},"devDependencies":{"typescript":"^5"}}',
    'requirements.txt': 'fastapi==0.110\nopencv-python\n',
    'go.mod': 'module demo\n\nrequire github.com/gin-gonic/gin v1.9.0\n',
  })
  const names = stack.map(entry => entry.name)
  for (const expected of ['React', 'Express', 'TypeScript', 'FastAPI', 'OpenCV', 'Go Modules', 'Gin']) {
    assert.ok(names.includes(expected), `应检出 ${expected}，实际 ${names.join(',')}`)
  }
  assert.equal(stack.find(entry => entry.name === 'React')!.evidence, 'package.json')
  assert.equal(stack.find(entry => entry.name === 'Gin')!.evidence, 'go.mod')
})

test('项目摘要渲染：规模、技术栈、声明、跳过文件、写作指引都在', () => {
  const markdown = renderProjectSummary({
    root: '04-实现',
    files: [
      summarizeSource('src/app.ts', 'export function main() {}\nexport class App {}'),
      summarizeSource('src/db.sql', 'CREATE TABLE users (id INT);'),
    ],
    manifests: { 'package.json': '{"dependencies":{"vue":"^3"}}' },
    skipped: ['src/big.min.js'],
  })
  assert.match(markdown, /# 代码结构摘要：04-实现/)
  assert.match(markdown, /源码文件：2 个/)
  assert.match(markdown, /\| typescript \| 1 \| 2 \|/)
  assert.match(markdown, /Vue　（证据：package\.json）/)
  assert.match(markdown, /`function` \*\*main\*\*/)
  assert.match(markdown, /`table` \*\*users\*\*/)
  assert.match(markdown, /## 未纳入摘要的文件/)
  assert.match(markdown, /src\/big\.min\.js/)
  assert.match(markdown, /## 怎么写进论文/)
  assert.match(markdown, /不含源码正文/)
})

test('项目摘要：没有可识别技术栈时如实说明，而不是留空', () => {
  const markdown = renderProjectSummary({ root: '04-实现', files: [], manifests: {}, skipped: [] })
  assert.match(markdown, /未在依赖清单里检出可识别技术栈/)
  assert.match(markdown, /未摄取到源码文件/)
})
