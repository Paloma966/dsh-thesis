/**
 * 文件系统错误分类：**区分「不存在」与「读失败」**。
 *
 * 这是本插件最容易出人命的一处细节。工作区里的文件都是学生的真实资产
 * （追问答案、进度台账、文献库、检索缓存），而几乎所有读路径的写法都是：
 *
 * ```ts
 * try { return await fs.readText(...) } catch { return undefined }   // ✗ 危险
 * ```
 *
 * 这种写法把「文件不存在（第一次运行，正常）」和「文件存在但读不出来
 * （权限、IO 错误、句柄失效）」折叠成同一个 `undefined`，调用方于是认为
 * 「还没建过」，转身用默认值把它**覆盖写回**——学生的数据就没了。
 *
 * 正确做法：只有**确认不存在**才当作 `undefined`，其余错误一律上抛，
 * 让工具以可读错误告知用户。宿主与各测试夹具的错误码不同，故在此集中判定。
 *
 * @module dsh-thesis/shared/fs-errors
 */

/** 各实现使用的「目标不存在」错误码。 */
export const MISSING_CODES: readonly string[] = ['ENOENT', 'FS_NOT_FOUND']

function codeOf(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : ''
}

/**
 * 该错误是否表示「目标不存在」？
 *
 * 判据按可靠性排序：错误码 → 消息里的 `ENOENT` / `not found` / `不存在`。
 * 消息回退是必要的：某些后端（含部分测试替身）不带错误码。
 */
export function isMissingError(error: unknown): boolean {
  const code = codeOf(error)
  if (code !== undefined) return MISSING_CODES.includes(code)
  const message = messageOf(error)
  if (message === '') return false
  return /\bENOENT\b|FS_NOT_FOUND|\bnot found\b|不存在|no such file/i.test(message)
}

/**
 * 该错误是否表示「调用被取消」。
 *
 * 取消与失败必须分开处理：把 `AbortError` 当成「文件不存在」会让取消变成静默继续，
 * 当成「检索源失败」又会让取消变成一条误导性的网络错误。`fetch` 与宿主 fs 在取消时
 * 抛的都是 `name === 'AbortError'` 的错误。
 */
export function isAbortError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  return (error as { name?: unknown }).name === 'AbortError'
}

/**
 * 读取一个「存在则读、不存在则 undefined」的文件；**其余错误原样抛出**。
 *
 * @param read 实际的读取动作（通常包住 `fs.resolve` + `fs.readText`）。
 * @param onMissing 命中「不存在」时的返回值，缺省 `undefined`。
 */
export async function readOrUndefined<T>(
  read: () => Promise<T>,
  onMissing: T | undefined = undefined,
): Promise<T | undefined> {
  try {
    return await read()
  } catch (error) {
    if (isMissingError(error)) return onMissing
    throw error
  }
}

/**
 * 把读取错误包装成给用户看的可读消息（工具层用）。
 *
 * 关键是把「读不出来」和「还没建过」在**文案上**也区分开，否则用户会以为
 * 自己的文件真的不存在，从而接受一次错误的覆盖。
 */
export function describeReadFailure(what: string, path: string, error: unknown, signal?: AbortSignal): string {
  if (signal?.aborted === true) return `${what}读取被取消（${path}）。`
  const code = codeOf(error)
  const suffix = code !== undefined ? `（错误码 ${code}）` : ''
  const detail = messageOf(error)
  return `${what}存在但读不出来：${path}${suffix}${detail === '' ? '' : ` —— ${detail}`}。可能是权限问题或文件损坏；`
    + '已停止本次操作，未覆盖任何已有内容。请检查该文件后重试。'
}
