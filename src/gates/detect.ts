/**
 * 闸门的判定逻辑：正则预编译 + 命中判断。零 cordis 依赖，可独立单测。
 *
 * 三条设计原则（都来自真实返工，不是审美）：
 * - **便宜**：只做启发式判断。误报的代价是模型多问一句，漏报的代价是整章按错误要求重写。
 * - **面向人**：闸门只负责「发现问题」，问题由模型转述、由用户回答。
 * - **有终止条件**：用户一句「直接写」即可绕开写作意图闸门；但**不可逆操作闸门不可绕过**——
 *   删除、强制推送这类操作必须由人当场拍板。
 *
 * @module dsh-thesis/gates/detect
 */

import type { DestructiveRule } from './writing-intent.ts'

/** 一条命中的高危命令规则：标签 + 命中的正则源。 */
export interface DestructiveHit {
  label: string
  pattern: string
}

/** 一条已编译的高危规则：预编译后的正则随标签一并保留，避免每次调用重新编译。 */
export interface CompiledDestructiveRule {
  label: string
  pattern: string
  regex: RegExp
}

/** 编译正则列表；无效模式跳过并上报，绝不把异常抛进 agent 循环。 */
export function compilePatterns(patterns: string[], onInvalid: (pattern: string) => void): RegExp[] {
  const compiled: RegExp[] = []
  for (const pattern of patterns) {
    try {
      compiled.push(new RegExp(pattern, 'i'))
    } catch {
      onInvalid(pattern)
    }
  }
  return compiled
}

/** 中文否定前缀：绕过标记前紧跟这些词时整句是否定（「不要直接写」不算授权）。 */
const CJK_NEGATION = '不要|不用|无需|别|勿|不'

function escapeRegExp(source: string): string {
  return source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 编译「已含验收标准/约束」的标记：按正则源编译。
 *
 * `criteriaMarkers` 里既有字面标记（如「验收」），也有条件句式正则（如「如果…就」），
 * 因此不做字面转义——字面标记本身不含正则元字符，直接当正则源编译即保持子串匹配语义。
 */
export function compileCriteriaMarkers(markers: string[], onInvalid: (marker: string) => void): RegExp[] {
  const compiled: RegExp[] = []
  for (const marker of markers) {
    try {
      compiled.push(new RegExp(marker, 'i'))
    } catch {
      onInvalid(marker)
    }
  }
  return compiled
}

/**
 * 编译「授权绕过」标记：字面短语 + 否定防护。
 *
 * 中文标记加负向后顾，使「不要直接写」「别直接写」不再命中「直接写」；
 * 纯拉丁标记用词边界包裹，避免「just write」命中「just write it later」这类子串误判。
 */
export function compileBypassMarkers(markers: string[], onInvalid: (marker: string) => void): RegExp[] {
  const compiled: RegExp[] = []
  for (const marker of markers) {
    try {
      const hasCjk = /[\u4e00-\u9fff]/.test(marker)
      const body = escapeRegExp(marker)
      const source = hasCjk ? `(?<!${CJK_NEGATION})${body}` : `\\b${body}\\b`
      compiled.push(new RegExp(source, 'i'))
    } catch {
      onInvalid(marker)
    }
  }
  return compiled
}

/** 预编译高危命令规则：一次编译，后续检测直接复用。 */
export function compileDestructiveRules(
  rules: DestructiveRule[],
  onInvalid: (pattern: string) => void,
): CompiledDestructiveRule[] {
  const compiled: CompiledDestructiveRule[] = []
  for (const rule of rules) {
    try {
      compiled.push({ label: rule.label, pattern: rule.pattern, regex: new RegExp(rule.pattern, 'i') })
    } catch {
      onInvalid(rule.pattern)
    }
  }
  return compiled
}

/**
 * 判断一段用户文本是否「有写作意图、但没带上验收标准」。
 *
 * @returns true = 应当触发写作意图闸门。
 */
export function isUnguardedWritingIntent(
  text: string,
  patterns: RegExp[],
  criteriaMarkers: RegExp[],
  bypassMarkers: RegExp[],
): boolean {
  if (bypassMarkers.some(marker => marker.test(text))) return false
  if (criteriaMarkers.some(marker => marker.test(text))) return false
  return patterns.some(pattern => pattern.test(text))
}

/**
 * 在命令字符串中查找第一条命中的高危规则。
 *
 * @param rules 已由 {@link compileDestructiveRules} 预编译的规则。
 * @returns 命中结果；无命中返回 undefined。
 */
export function findDestructiveHit(command: string, rules: CompiledDestructiveRule[]): DestructiveHit | undefined {
  for (const rule of rules) {
    if (rule.regex.test(command)) return { label: rule.label, pattern: rule.pattern }
  }
  return undefined
}
