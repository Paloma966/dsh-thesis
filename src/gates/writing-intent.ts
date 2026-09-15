/**
 * 闸门配置：写作意图闸门（要求没谈清就不许开写）+ 不可逆操作闸门。
 *
 * 本文件是**默认值的单一来源**：schema 的 `.default()` 与代码侧回退
 * （直接 `apply()` 的测试/冒烟路径）共用同一份常量，绝不让「缺配置」
 * 退化成「静默关闸门」。
 *
 * 注意这个配置块的字段名描述的是**论文场景里的行为**，不是抽象的技术术语：
 * `writingGate`（要开写但要求没谈清时拦截）、`destructiveGate`（不可逆操作前提请拍板）。
 *
 * @module dsh-thesis/gates/writing-intent
 */

/** 一条不可逆操作规则：人类可读标签 + 正则（忽略大小写编译）。 */
export interface DestructiveRule {
  /** 展示给用户的规则名，如「递归强制删除」。 */
  label: string
  /** 匹配命令字符串的正则模式。 */
  pattern: string
}

/** 闸门配置（全部可选，均有出厂默认值）。 */
export interface GateOptions {
  /** 写作意图闸门：用户要开写但要求没谈清时，注入指令强制先追问（默认开）。 */
  writingGate?: boolean
  /** 判定「要开写」的正则列表（忽略大小写）。 */
  writingIntentPatterns?: string[]
  /** 命中任一即视为「已带验收标准/约束」、不再拦截的正则列表（忽略大小写）。 */
  criteriaMarkers?: string[]
  /** 用户显式授权「不用问，直接写」的短语，命中即放行。 */
  bypassMarkers?: string[]
  /** 注入指令允许模型一次向用户提出的最大问题数（正整数）。 */
  maxQuestions?: number
  /** 不可逆操作闸门：破坏性命令执行前提请用户拍板（默认开）。 */
  destructiveGate?: boolean
  /** 参与高危检测的工具名列表（默认只查 bash）。 */
  destructiveToolNames?: string[]
  /** 不可逆操作规则列表。 */
  destructiveRules?: DestructiveRule[]
}

/** `GateOptions` 的别名，供 `src/config.ts` 复用。 */
export type Config = GateOptions

/**
 * 「要开写论文」的实现意图模式。
 *
 * 只匹配真正的写作动词 + 论文产物，避免把「问一下第三章怎么写」也拦住。
 */
const WRITING_PATTERNS = [
  // 中文：写作动词 + 论文产物
  '(请|帮我|帮忙|来)?\\s*(写|撰写|起草|生成|补写|续写|接着写|继续写|开始写|完成|改|修改|润色|重写)[^。！？\\n]{0,12}(论文|正文|章节|第[一二三四五六七八九十0-9]{1,3}章|绪论|引言|结论|结语|摘要|致谢|开题报告|任务书|中期报告|文献综述|相关技术|需求分析|系统设计|系统实现|系统测试)',
  // 中文：直接点名章节文件（01-绪论.md）
  '\\b0[1-7]-[^\\s，。]{2,12}\\.md\\b',
  // 英文：write/draft + thesis 产物
  '\\b(write|draft|compose|generate|rewrite|revise)\\b[^.\\n]{0,24}\\b(thesis|paper|chapter|abstract|proposal|literature review)\\b',
]

const CRITERIA_MARKERS = [
  // 验收/成功标准
  '验收', '成功标准', '完成标准', '合格标准', '通过标准', '满足以下', '满足如下',
  'acceptance', 'criteria', 'definition of done', 'expected', 'expectation',
  // 测试与可证伪描述
  '测试用例', '测试计划', '单元测试', '集成测试', 'test case', 'behavior',
  // 边界与非目标
  '非目标', 'non-goal', '不做', '不包含', '边界', 'scope',
  // 约束与取舍
  '约束', 'constraint', '期限', 'deadline', '预算', 'budget',
  '优先级', 'priority', '权衡', 'trade-off', '必须支持', '需要支持', '先',
  // 条件-验收句式（如果/当…就/那么/则/时/便）：只有带后件才是真条件句式，
  // 裸的「如果」「when」「if」不再放行（如「如果有空」仍应触发闸门）。
  '如果[^。！？；\\n]{0,20}?(就|那么|则|便)',
  '当[^。！？；\\n]{0,20}?(时|就)',
  '\\bwhen\\b[^.\\n]{0,20}?\\bthen\\b',
  '\\bif\\b[^.\\n]{0,20}?\\bthen\\b',
]

const BYPASS_MARKERS = [
  '直接写', '直接做', '直接生成', '不用问', '别问了', '不需要提问', '跳过追问', '跳过提问',
  '无需澄清', '按我说的写', '我已经想清楚', '想清楚了', 'just write', 'just do it',
]

const DESTRUCTIVE_RULES: DestructiveRule[] = [
  { label: '递归删除', pattern: '\\brm\\s+-[a-z]*r[a-z]*' },
  { label: '强制推送 / 硬重置', pattern: '\\bgit\\s+(push[^\\n]*(--force|-f)|reset\\s+(--hard|-f))' },
  { label: '清除未跟踪文件', pattern: '\\bgit\\s+clean\\b' },
  { label: '数据库破坏性语句', pattern: '\\b(drop\\s+(table|database|index)|truncate(\\s+table)?\\b|delete\\s+from\\b)' },
  { label: '磁盘分区 / 格式化 / dd 覆写', pattern: '\\b(mkfs\\.|fdisk|parted\\b|dd\\s+if=)' },
  { label: '写入设备文件', pattern: '>\\s*/dev/\\S+' },
  { label: '管道执行远程脚本', pattern: '(curl|wget)[^|\\n]*\\|\\s*(sudo\\s+)?(ba)?sh\\b' },
  { label: '权限放开', pattern: 'chmod\\s+(-R\\s+)?(777|a\\+rwx)' },
  { label: '关机 / 重启', pattern: '\\b(shutdown|reboot|poweroff)\\b' },
  { label: '强制覆盖历史', pattern: '\\bgit\\s+(push\\b[^\\n]*\\+[^\\s]*:|commit\\s+--amend\\b)' },
]

/** 出厂默认值（schema 与代码回退共用）。 */
export const GATE_DEFAULTS: {
  writingIntentPatterns: string[]
  criteriaMarkers: string[]
  bypassMarkers: string[]
  maxQuestions: number
  destructiveToolNames: string[]
  destructiveRules: DestructiveRule[]
} = {
  writingIntentPatterns: WRITING_PATTERNS,
  criteriaMarkers: CRITERIA_MARKERS,
  bypassMarkers: BYPASS_MARKERS,
  maxQuestions: 3,
  destructiveToolNames: ['bash'],
  destructiveRules: DESTRUCTIVE_RULES,
}
