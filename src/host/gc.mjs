/**
 * V8 堆回收（可选功能，默认关闭）。
 *
 * 实测（本机 DSH 宿主，heapUsed ~535 MB）：
 * - `minor` GC：~4 ms；
 * - `major` GC：~140 ms；
 * - `major-snapshot` GC：**~10.7 s**，而且会把 RSS 顶高 777 MB —— 绝对不能用。
 *
 * 更关键的是：强制 GC 之后 RSS 只降了 **9.3 MiB**。
 * 也就是说 V8 堆根本不是这个进程占内存的主因，
 * 真正的杠杆是原生分配器（见 src/host/trim/）。
 * 所以 GC 只作为"顺带做一下"的开关提供，默认关闭。
 *
 * @module dsh-lowmem/host/gc
 */
import v8 from 'node:v8'
import vm from 'node:vm'

/** 懒加载出来的 gc 函数。 */
let gcFunction = null

/**
 * 取出暴露出来的 gc 函数（只做一次）。
 * @returns {(() => void) | null} gc 函数；不可用时返回 null。
 */
export function resolveGc() {
  if (gcFunction) return gcFunction
  try {
    v8.setFlagsFromString('--expose-gc')
    const candidate = vm.runInNewContext('gc')
    if (typeof candidate === 'function') {
      gcFunction = candidate
      return gcFunction
    }
  } catch {
    // 拿不到就算了：本功能是可选项，失败不影响主流程。
  }
  return null
}

/**
 * 执行一次指定类型的 GC。
 *
 * 永远不抛：GC 失败只是少回收一点内存，不该影响宿主。
 * @param {'minor' | 'major'} mode - GC 类型。
 * @returns {{ok: boolean, durationMs: number, error?: string}} 执行结果。
 */
export function runGc(mode = 'minor') {
  const gc = resolveGc()
  if (!gc) return { ok: false, durationMs: 0, error: '当前运行时未暴露 gc' }
  const started = Date.now()
  try {
    // 只允许 minor / major：major-snapshot 实测 10.7 s 且顶高 RSS。
    gc({ type: mode === 'major' ? 'major' : 'minor' })
    return { ok: true, durationMs: Date.now() - started }
  } catch (error) {
    return {
      ok: false,
      durationMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
