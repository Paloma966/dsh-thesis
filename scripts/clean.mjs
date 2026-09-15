/**
 * 构建前清空输出目录。
 *
 * **为什么必须有这一步**：`tsc` 只写不删。重命名或删除一个模块后，它对应的
 * 旧编译产物会永远留在 `lib/` 里——`lib/` 又在 `.gitignore` 里，`git clean`
 * 清不掉，于是：
 *
 * - 搜索引擎与 grep 会一直命中已经删掉的模块（"重构完了怎么还有旧模块目录？"）；
 * - 更危险的是这些孤儿文件**仍可被解析**：任何按旧路径 import 的代码都能成功，
 *   把「模块已经删掉」这件事掩盖成运行时才发作的怪问题；
 * - `scripts/host-smoke.mjs` 会把 `lib/` 整个拷进冒烟目录，因此孤儿产物还会被
 *   复制进"真实宿主"验证环境，让验证结果不可信。
 *
 * 因此构建的第一步是删掉整个 `lib/`，保证"产物 == 当前源码"。
 *
 * @module dsh-thesis/scripts/clean
 */

import { existsSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 需要清掉的构建/运行产物目录（相对于仓库根）。 */
const OUTPUT_DIRS = [
  'lib', // tsc 输出
  '.host-smoke', // host-smoke 生成的假 app（含 lib/ 拷贝）
  '.host-verify', // host-verify 生成的临时补丁层
]

let removed = 0
for (const rel of OUTPUT_DIRS) {
  const target = join(repoRoot, rel)
  if (!existsSync(target)) continue
  rmSync(target, { recursive: true, force: true })
  console.log(`[clean] 已删除 ${rel}/`)
  removed += 1
}
if (removed === 0) console.log('[clean] 无需清理')
