/**
 * 演练引擎的结构化错误。每一次拒绝都携带稳定的 `code`，调用方（命令、工具）
 * 因此可以按 code 分支，而不必去匹配文案。
 *
 * @module dsh-thesis/codewalk
 */

export type LearningErrorCode =
  /** create 要求目标不存在，但已有状态文件。 */
  | 'STATE_EXISTS'
  /** 状态文件存在但无法解析或校验失败。 */
  | 'STATE_INVALID'
  /** 请求的迁移违反状态机。 */
  | 'ILLEGAL_TRANSITION'
  /** 里程碑 id 未知。 */
  | 'MILESTONE_UNKNOWN'
  /** todo id 未知。 */
  | 'TODO_UNKNOWN'
  /** 问题下标越界。 */
  | 'QUESTION_UNKNOWN'
  /** 该语言在解析后的配置里没有验证门。 */
  | 'GATE_UNKNOWN'
  /** 没有组合 shell 执行器，验证门无法运行。 */
  | 'SHELL_MISSING'

/** 一次被拒绝的演练引擎操作。 */
export class LearningError extends Error {
  /** 稳定的机器可读 code。 */
  readonly code: LearningErrorCode

  constructor(code: LearningErrorCode, message: string) {
    super(message)
    this.name = 'LearningError'
    this.code = code
  }
}

/** 任意拒绝是否为 LearningError。 */
export function isLearningError(error: unknown): error is LearningError {
  return error instanceof LearningError
}
