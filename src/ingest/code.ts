/**
 * 代码结构摘要：把源码变成「论文与答辩用得上的结构信息」，而不是原文倒出。
 *
 * 为什么不做成"把源码当文本读"：一个课程设计仓库动辄上万行，倒进上下文既挤爆预算、
 * 又对写作没有帮助。真正有用的是**结构**——有哪些文件、各多少行、定义了哪些类与函数、
 * 入口在哪、用了什么技术栈、依赖清单说了什么。这些正是：
 * - 论文「系统实现」章的骨架；
 * - `thesis_defense` 的「工作量」证据（文件数/代码行数）；
 * - 答辩必问「你的系统怎么实现的」的可检索索引；
 * - `code-walkthrough` 做代码演练时的地图。
 *
 * 纯函数、无宿主依赖、零第三方库：只用正则做**结构化信号提取**（不求 AST 精度），
 * 因此结果里只报"检出"，不谎称"完整解析"。
 *
 * @module dsh-thesis/ingest/code
 */

/** 支持结构摘要的语言。 */
export type CodeLanguage =
  | 'typescript' | 'javascript' | 'python' | 'java' | 'go' | 'rust'
  | 'c' | 'cpp' | 'csharp' | 'php' | 'ruby' | 'kotlin' | 'swift'
  | 'sql' | 'shell' | 'vue' | 'html' | 'css'

/** 扩展名 → 语言。 */
const LANGUAGE_BY_EXTENSION: Readonly<Record<string, CodeLanguage>> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python', '.pyw': 'python',
  '.java': 'java',
  '.go': 'go',
  '.rs': 'rust',
  '.c': 'c', '.h': 'c',
  '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.hh': 'cpp',
  '.cs': 'csharp',
  '.php': 'php',
  '.rb': 'ruby',
  '.kt': 'kotlin', '.kts': 'kotlin',
  '.swift': 'swift',
  '.sql': 'sql',
  '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell', '.ps1': 'shell', '.bat': 'shell',
  '.vue': 'vue',
  '.html': 'html', '.htm': 'html',
  '.css': 'css', '.scss': 'css', '.less': 'css',
}

/** 依赖/构建清单文件（用于技术栈指纹）。 */
const MANIFEST_NAMES: readonly string[] = [
  'package.json', 'pnpm-lock.yaml', 'yarn.lock', 'package-lock.json',
  'requirements.txt', 'pyproject.toml', 'pipfile', 'environment.yml',
  'go.mod', 'cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts',
  'composer.json', 'gemfile', 'dockerfile', 'docker-compose.yml', 'makefile',
]

/** 语言名（用于摘要文本）。 */
export function languageLabel(language: CodeLanguage): string {
  return language
}

/** 是否是受支持的源码文件；不是则返回 `undefined`。 */
export function codeLanguageOf(path: string): CodeLanguage | undefined {
  const lower = path.toLowerCase().replace(/\\/g, '/')
  const base = lower.slice(lower.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return undefined
  return LANGUAGE_BY_EXTENSION[base.slice(dot)]
}

/** 是否是依赖/构建清单。 */
export function isManifestFile(path: string): boolean {
  const lower = path.toLowerCase().replace(/\\/g, '/')
  const base = lower.slice(lower.lastIndexOf('/') + 1)
  return MANIFEST_NAMES.includes(base)
}

/** 索引进摘要的声明（只报检出，不做 AST 解析）。 */
export interface CodeDeclaration {
  readonly kind: string
  readonly name: string
  readonly line: number
}

/** 单文件摘要。 */
export interface CodeFileSummary {
  readonly rel: string
  readonly language: CodeLanguage
  readonly lines: number
  readonly codeLines: number
  readonly commentLines: number
  readonly blankLines: number
  /** 声明的函数/类/接口/路由/表等（最多保留前 {@link MAX_DECLARATIONS_PER_FILE} 条）。 */
  readonly declarations: readonly CodeDeclaration[]
  /** 是否因超过行数上限而被截断摘要。 */
  readonly truncated: boolean
}

/** 每个文件最多索引多少条声明（防止超大生成文件把摘要撑爆）。 */
export const MAX_DECLARATIONS_PER_FILE = 40

/** 单文件最多扫描多少行。 */
export const MAX_SCAN_LINES = 20_000

interface Pattern {
  readonly kind: string
  readonly regex: RegExp
}

/** 各语言的声明模式（顺序即优先级，命中即记录，同名字取首个）。 */
const PATTERNS: Readonly<Record<CodeLanguage, readonly Pattern[]>> = {
  typescript: [
    { kind: 'function', regex: /^\s*export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/ },
    { kind: 'function', regex: /^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/ },
    { kind: 'class', regex: /^\s*export\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
    { kind: 'class', regex: /^\s*(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
    { kind: 'interface', regex: /^\s*export\s+interface\s+([A-Za-z_$][\w$]*)/ },
    { kind: 'type', regex: /^\s*export\s+type\s+([A-Za-z_$][\w$]*)/ },
    { kind: 'enum', regex: /^\s*export\s+enum\s+([A-Za-z_$][\w$]*)/ },
    { kind: 'const', regex: /^\s*export\s+const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\(|<)/ },
    { kind: 'route', regex: /\.\s*(?:get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/ },
  ],
  javascript: [
    { kind: 'function', regex: /^\s*export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/ },
    { kind: 'function', regex: /^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/ },
    { kind: 'class', regex: /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/ },
    { kind: 'route', regex: /\.\s*(?:get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/ },
  ],
  python: [
    { kind: 'class', regex: /^\s*class\s+([A-Za-z_]\w*)/ },
    { kind: 'function', regex: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/ },
    { kind: 'route', regex: /@\w+\.(?:route|get|post|put|delete)\s*\(\s*['"]([^'"]+)['"]/ },
  ],
  java: [
    { kind: 'class', regex: /^\s*(?:public|protected|private)?\s*(?:final\s+|abstract\s+)?(?:class|interface|enum)\s+([A-Za-z_]\w*)/ },
    { kind: 'method', regex: /^\s*(?:public|protected|private)\s+(?:static\s+|final\s+|synchronized\s+)*[\w<>\[\],.\s]+\s+([A-Za-z_]\w*)\s*\(/ },
  ],
  go: [
    { kind: 'function', regex: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/ },
    { kind: 'struct', regex: /^type\s+([A-Za-z_]\w*)\s+struct/ },
    { kind: 'interface', regex: /^type\s+([A-Za-z_]\w*)\s+interface/ },
  ],
  rust: [
    { kind: 'function', regex: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/ },
    { kind: 'struct', regex: /^\s*(?:pub\s+)?struct\s+([A-Za-z_]\w*)/ },
    { kind: 'enum', regex: /^\s*(?:pub\s+)?enum\s+([A-Za-z_]\w*)/ },
    { kind: 'trait', regex: /^\s*(?:pub\s+)?trait\s+([A-Za-z_]\w*)/ },
  ],
  c: [
    { kind: 'struct', regex: /^\s*(?:typedef\s+)?struct\s+([A-Za-z_]\w*)/ },
    { kind: 'function', regex: /^[A-Za-z_][\w\s*]*\s+([A-Za-z_]\w*)\s*\([^;]*\)\s*\{/ },
  ],
  cpp: [
    { kind: 'class', regex: /^\s*class\s+([A-Za-z_]\w*)/ },
    { kind: 'struct', regex: /^\s*(?:typedef\s+)?struct\s+([A-Za-z_]\w*)/ },
    { kind: 'function', regex: /^[A-Za-z_][\w:<>*&\s]*\s+([A-Za-z_]\w*)\s*\([^;]*\)\s*\{/ },
  ],
  csharp: [
    { kind: 'class', regex: /^\s*(?:public|internal|private|protected)?\s*(?:sealed\s+|abstract\s+|partial\s+)*(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/ },
    { kind: 'method', regex: /^\s*(?:public|private|protected|internal)\s+(?:static\s+|async\s+|virtual\s+|override\s+)*[\w<>\[\],.\s]+\s+([A-Za-z_]\w*)\s*\(/ },
  ],
  php: [
    { kind: 'class', regex: /^\s*(?:final\s+|abstract\s+)?class\s+([A-Za-z_]\w*)/ },
    { kind: 'function', regex: /^\s*(?:public|private|protected|static|\s)*function\s+([A-Za-z_]\w*)/ },
  ],
  ruby: [
    { kind: 'class', regex: /^\s*class\s+([A-Za-z_]\w*)/ },
    { kind: 'function', regex: /^\s*def\s+([A-Za-z_]\w*[?!=]?)/ },
  ],
  kotlin: [
    { kind: 'class', regex: /^\s*(?:data\s+|sealed\s+|open\s+|abstract\s+)?class\s+([A-Za-z_]\w*)/ },
    { kind: 'function', regex: /^\s*(?:private\s+|internal\s+|public\s+)?fun\s+([A-Za-z_]\w*)/ },
  ],
  swift: [
    { kind: 'class', regex: /^\s*(?:final\s+|open\s+)?(?:class|struct|enum|protocol)\s+([A-Za-z_]\w*)/ },
    { kind: 'function', regex: /^\s*(?:public\s+|private\s+|internal\s+)?func\s+([A-Za-z_]\w*)/ },
  ],
  sql: [
    { kind: 'table', regex: /^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"[]?([A-Za-z_]\w*)/i },
    { kind: 'view', regex: /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+[`"[]?([A-Za-z_]\w*)/i },
  ],
  shell: [
    { kind: 'function', regex: /^\s*(?:function\s+)?([A-Za-z_]\w*)\s*\(\s*\)\s*\{/ },
  ],
  vue: [
    { kind: 'component', regex: /^\s*defineComponent\s*\(\s*\{?\s*name:\s*['"]([^'"]+)['"]/ },
    { kind: 'function', regex: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/ },
    { kind: 'const', regex: /^\s*const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:ref|reactive|computed|defineProps|defineEmits)\b/ },
  ],
  html: [
    { kind: 'script', regex: /<script[^>]*src=["']([^"']+)["']/i },
    { kind: 'link', regex: /<link[^>]*href=["']([^"']+)["']/i },
  ],
  css: [
    { kind: 'selector', regex: /^([.#][A-Za-z_][\w-]*)\s*\{/ },
  ],
}

/** 是否是注释行（语言无关的粗判；不求精确）。 */
function isCommentLine(line: string, language: CodeLanguage): boolean {
  const trimmed = line.trim()
  if (trimmed === '') return false
  if (language === 'python' || language === 'shell' || language === 'ruby') return trimmed.startsWith('#')
  if (language === 'sql') return trimmed.startsWith('--')
  if (language === 'html') return trimmed.startsWith('<!--')
  if (language === 'css') return trimmed.startsWith('/*') || trimmed.startsWith('*')
  return trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('*/')
}

/**
 * 摘要一个源码文件。
 *
 * @param rel - 展示用相对路径
 * @param text - 文件内容（已解码）
 */
export function summarizeSource(rel: string, text: string): CodeFileSummary {
  const language = codeLanguageOf(rel) ?? 'typescript'
  const allLines = text.split('\n')
  const truncated = allLines.length > MAX_SCAN_LINES
  const lines = truncated ? allLines.slice(0, MAX_SCAN_LINES) : allLines

  let blankLines = 0
  let commentLines = 0
  const declarations: CodeDeclaration[] = []
  const seen = new Set<string>()
  const patterns = PATTERNS[language] ?? []

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    if (line.trim() === '') {
      blankLines += 1
      continue
    }
    if (isCommentLine(line, language)) {
      commentLines += 1
      continue
    }
    if (declarations.length >= MAX_DECLARATIONS_PER_FILE) continue
    for (const pattern of patterns) {
      const match = pattern.regex.exec(line)
      const name = match?.[1]
      if (name === undefined || name === '') continue
      const key = `${pattern.kind}:${name}`
      if (seen.has(key)) break
      seen.add(key)
      declarations.push({ kind: pattern.kind, name, line: index + 1 })
      break
    }
  }

  return {
    rel,
    language,
    lines: allLines.length,
    codeLines: lines.length - blankLines - commentLines,
    commentLines,
    blankLines,
    declarations,
    truncated,
  }
}

/** 技术栈指纹（依赖清单里检出的名字 + 证据文件）。 */
export interface TechStackEntry {
  readonly name: string
  readonly evidence: string
}

const STACK_SIGNALS: readonly { readonly name: string; readonly regex: RegExp }[] = [
  { name: 'Node.js / npm', regex: /"(?:dependencies|devDependencies)"\s*:/ },
  { name: 'React', regex: /"react"\s*:/ },
  { name: 'Vue', regex: /"vue"\s*:/ },
  { name: 'Angular', regex: /"@angular\/core"\s*:/ },
  { name: 'Express', regex: /"express"\s*:/ },
  { name: 'Koa', regex: /"koa"\s*:/ },
  { name: 'NestJS', regex: /"@nestjs\/core"\s*:/ },
  { name: 'TypeScript', regex: /"typescript"\s*:/ },
  { name: 'Vite', regex: /"vite"\s*:/ },
  { name: 'Webpack', regex: /"webpack"\s*:/ },
  { name: 'Next.js', regex: /"next"\s*:/ },
  { name: 'FastAPI', regex: /fastapi/i },
  { name: 'Flask', regex: /flask/i },
  { name: 'Django', regex: /django/i },
  { name: 'PyTorch', regex: /torch/i },
  { name: 'TensorFlow', regex: /tensorflow/i },
  { name: 'NumPy', regex: /numpy/i },
  { name: 'Pandas', regex: /pandas/i },
  { name: 'OpenCV', regex: /opencv/i },
  { name: 'Spring Boot', regex: /spring-boot/i },
  { name: 'MyBatis', regex: /mybatis/i },
  { name: 'Maven', regex: /<groupId>/ },
  { name: 'Gradle', regex: /plugins\s*\{|dependencies\s*\{/ },
  { name: 'Go Modules', regex: /^module\s+\S+/m },
  { name: 'Gin', regex: /gin-gonic\/gin/ },
  { name: 'Cargo / Rust', regex: /^\[package\]/m },
  { name: 'MySQL', regex: /mysql/i },
  { name: 'PostgreSQL', regex: /postgres/i },
  { name: 'SQLite', regex: /sqlite/i },
  { name: 'Redis', regex: /redis/i },
  { name: 'MongoDB', regex: /mongo/i },
  { name: 'Docker', regex: /FROM\s+\S+|services:/i },
  { name: 'Composer / PHP', regex: /"require"\s*:/ },
]

/** 从清单文件内容推断技术栈。 */
export function detectTechStack(manifests: Readonly<Record<string, string>>): TechStackEntry[] {
  const entries: TechStackEntry[] = []
  const seen = new Set<string>()
  for (const [rel, content] of Object.entries(manifests)) {
    for (const signal of STACK_SIGNALS) {
      if (seen.has(signal.name)) continue
      if (signal.regex.test(content)) {
        seen.add(signal.name)
        entries.push({ name: signal.name, evidence: rel })
      }
    }
  }
  return entries
}

/** 项目级代码结构摘要的输入。 */
export interface ProjectCodeSummary {
  readonly root: string
  readonly files: readonly CodeFileSummary[]
  readonly manifests: Readonly<Record<string, string>>
  /** 未能摘要的文件（超大/读取失败），如实列出而不是假装没有。 */
  readonly skipped: readonly string[]
}

/** 渲染成 Markdown（写进 `00-管理/材料/` 的摘要文件）。 */
export function renderProjectSummary(summary: ProjectCodeSummary): string {
  const byLanguage = new Map<CodeLanguage, { files: number; lines: number }>()
  for (const file of summary.files) {
    const bucket = byLanguage.get(file.language) ?? { files: 0, lines: 0 }
    bucket.files += 1
    bucket.lines += file.lines
    byLanguage.set(file.language, bucket)
  }
  const totalLines = summary.files.reduce((sum, file) => sum + file.lines, 0)
  const totalCode = summary.files.reduce((sum, file) => sum + file.codeLines, 0)

  const lines: string[] = []
  lines.push(`# 代码结构摘要：${summary.root}`)
  lines.push('')
  lines.push('> 由 `thesis_ingest` 生成。这里只记录**结构信号**（文件、行数、声明、入口、技术栈），')
  lines.push('> 不含源码正文——论文「系统实现」章与答辩素材应从这些结构出发，而不是粘贴代码。')
  lines.push('')
  lines.push('## 规模')
  lines.push('')
  lines.push(`- 源码文件：${summary.files.length} 个`)
  lines.push(`- 总行数：${totalLines} 行（其中代码行 ${totalCode} 行）`)
  lines.push('')
  if (byLanguage.size > 0) {
    lines.push('| 语言 | 文件数 | 行数 |')
    lines.push('|---|---|---|')
    for (const [language, bucket] of [...byLanguage.entries()].sort((a, b) => b[1].lines - a[1].lines)) {
      lines.push(`| ${language} | ${bucket.files} | ${bucket.lines} |`)
    }
    lines.push('')
  }

  const stack = detectTechStack(summary.manifests)
  lines.push('## 技术栈（由依赖清单推断，须与你的实际选型核对）')
  lines.push('')
  if (stack.length === 0) {
    lines.push('- 未在依赖清单里检出可识别技术栈；若确有依赖文件，请确认它在本目录内。')
  } else {
    for (const entry of stack) lines.push(`- ${entry.name}　（证据：${entry.evidence}）`)
  }
  lines.push('')

  lines.push('## 文件与主要声明')
  lines.push('')
  if (summary.files.length === 0) {
    lines.push('- （未摄取到源码文件：确认 path 指向代码目录，且没有被 SKIP_DIRS 跳过）')
    lines.push('')
  }
  for (const file of [...summary.files].sort((a, b) => b.lines - a.lines)) {
    const parts: string[] = [`${file.lines} 行`]
    if (file.commentLines > 0) parts.push(`注释 ${file.commentLines}`)
    if (file.truncated) parts.push('已截断摘要')
    lines.push(`### ${file.rel}　（${file.language}，${parts.join('，')}）`)
    lines.push('')
    if (file.declarations.length === 0) {
      lines.push('- （未检出顶层声明）')
    } else {
      for (const declaration of file.declarations) {
        lines.push(`- \`${declaration.kind}\` **${declaration.name}**　（第 ${declaration.line} 行）`)
      }
    }
    lines.push('')
  }

  if (summary.skipped.length > 0) {
    lines.push('## 未纳入摘要的文件')
    lines.push('')
    for (const rel of summary.skipped) lines.push(`- ${rel}`)
    lines.push('')
    lines.push('（原因通常是文件过大或读取失败——需要时请单独查看。）')
    lines.push('')
  }

  lines.push('## 怎么写进论文')
  lines.push('')
  lines.push('1. 「系统实现」章按**模块**组织：每个主要文件/声明的职责 + 关键实现取舍（而不是贴代码）；')
  lines.push('2. 「系统设计」章的模块划分应与这里的文件/声明结构一致，答辩时能一一指认；')
  lines.push('3. 工作量证据用这里的文件数与代码行数，但**不要**把它们直接写进正文当论据堆砌；')
  lines.push('4. 想让老师追问不倒你，用 `defense_code_status`/`defense_code_next` 建代码演练（配合 `code-walkthrough` 技能）。')
  lines.push('')
  return lines.join('\n')
}
