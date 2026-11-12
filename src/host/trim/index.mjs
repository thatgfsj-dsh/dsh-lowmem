/**
 * 原生分配器回收（native trim）入口。
 *
 * 为什么需要这一层：宿主进程长跑之后，V8 堆之外的分配器（glibc malloc / macOS malloc zone /
 * Windows 工作集）会攒下不少空闲页——JS 堆看着空，RSS 却下不来。各平台「把空闲页还给
 * 操作系统」的入口完全不同，这里统一成同一个 Trimmer 形状交给上层。
 *
 * 硬性约束（见 docs/CONTRACT.md §2.1）：
 * - koffi 懒加载：必须在 createTrimmer 内部 `await import('koffi')`，模块顶层不 import，
 *   否则没装 koffi（或 koffi 装错平台）的机器只要 import 本文件就会直接崩掉。
 * - trim() 永不抛异常：任何失败都转成 { ok:false, error, rssDeltaBytes:0, durationMs }。
 * - 平台差异（库名/符号名/返回值语义）全部下沉到各平台策略文件，本文件只做调度与兜底。
 * - **回收量分两个字段**：`rssDeltaBytes` 是进程级 RSS 净变化（会混入采样窗口内其它来源的
 *   变化）；`nativeReleasedBytes` 是原生机制**自报**的释放量，只有真正返回字节数的平台才有。
 *   Windows 的 EmptyWorkingSet 只是把工作集换出到页面文件，kind = 'swap-out'，语义与其它平台相反。
 */

import { createDarwinStrategy } from './darwin.mjs'
import { createLinuxStrategy } from './linux.mjs'
import { createUnsupportedTrimmer } from './unsupported.mjs'
import { createWin32Strategy } from './win32.mjs'

/**
 * @typedef {object} TrimOutcome
 * @property {boolean} ok            - 本次调用是否成功。
 * @property {number} rssDeltaBytes  - 调用前后 RSS 差值（进程级净变化，>=0）。
 * @property {number|null} nativeReleasedBytes - 原生自报的释放字节数；没有则为 null。
 * @property {number} durationMs     - 调用耗时（毫秒）。
 * @property {string} [error]        - 失败原因（仅 ok=false 时）。
 *
 * @typedef {object} Trimmer
 * @property {boolean} available - 当前平台是否支持原生回收。
 * @property {string|null} name  - 机制名：'malloc_trim' | 'malloc_zone_pressure_relief' | 'EmptyWorkingSet' | null。
 * @property {'reclaim'|'swap-out'|null} kind - reclaim=真的还给 OS；swap-out=换出到页面文件。
 * @property {string} detail     - 人类可读的状态说明（不支持时说明原因）。
 * @property {(opts?: {rssBytes?: number}) => TrimOutcome} trim - 执行一次回收。
 */

/** 平台 → 策略工厂。表里没有的平台（以及 musl 这类缺符号的 libc）一律走降级实现。 */
const PLATFORM_STRATEGIES = new Map([
  ['linux', createLinuxStrategy],
  ['darwin', createDarwinStrategy],
  ['win32', createWin32Strategy],
])

/**
 * 把 import 到的 koffi 规整成「有 load() 的对象」。
 * koffi 是 CommonJS 打包 + ESM 再导出，命名导出与 default 导出都可能有，取到哪个算哪个。
 * @param {unknown} mod - import('koffi') 的结果，或测试注入的假 koffi。
 * @returns {object|null} 可用的 koffi 对象；不可用时返回 null。
 */
function normalizeKoffi(mod) {
  if (mod === null || typeof mod !== 'object') return null
  if (typeof mod.load === 'function') return mod
  const fallback = mod.default
  if (fallback !== undefined && fallback !== null && typeof fallback.load === 'function') return fallback
  return null
}

/**
 * 读一次 RSS（字节）。读取失败按 0 处理，采样故障不应该影响回收本身。
 * @returns {number} RSS 字节数；读取失败时为 0。
 */
function readRssBytes() {
  try {
    return process.memoryUsage().rss
  } catch {
    return 0
  }
}

/**
 * 生成回收执行器：包住原生调用，吞掉所有异常，并算出两个口径的回收量。
 *
 * - `rssDeltaBytes`：调用前后 RSS 差值。**这是进程级净变化**，采样窗口里别的线程释放了内存
 *   也会被算进来，所以它不等于「本机制释放给 OS 的字节」。
 * - `nativeReleasedBytes`：只有原生明确返回字节数时才有值（macOS 的 malloc_zone_pressure_relief）。
 *   glibc 的 malloc_trim 返回的是「有没有真的释放」的标志位（0/1），Windows 的 EmptyWorkingSet
 *   返回 BOOL —— 这两个平台一律填 null，绝不能把标志位当字节数。
 *
 * @param {() => unknown} nativeTrim - 原生回收调用，允许抛异常。
 * @param {boolean} nativeReturnsBytes - 原生返回值是否为「释放字节数」（仅 macOS 为真）。
 * @returns {(opts?: {rssBytes?: number}) => TrimOutcome} 永不抛异常的回收函数。
 */
function createTrimRunner(nativeTrim, nativeReturnsBytes) {
  return function trim(opts = {}) {
    const startedAt = Date.now()
    // 调用方已经采过 RSS 就直接用它的值，省掉一次重复采样带来的抖动。
    const before = Number.isFinite(opts?.rssBytes) && opts.rssBytes >= 0 ? opts.rssBytes : readRssBytes()
    try {
      const native = nativeTrim()
      const after = readRssBytes()
      let rssDeltaBytes = before - after
      // RSS 也可能因为别的原因涨了，变化量只报非负数。
      if (rssDeltaBytes < 0) rssDeltaBytes = 0
      // 原生自报字节数：只在平台确实返回字节数、且值合理时采信。
      let nativeReleasedBytes = null
      if (nativeReturnsBytes && Number.isFinite(native) && native > 0) {
        nativeReleasedBytes = native
      }
      return {
        ok: true,
        rssDeltaBytes,
        nativeReleasedBytes,
        durationMs: Math.max(0, Date.now() - startedAt),
      }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        rssDeltaBytes: 0,
        nativeReleasedBytes: null,
        durationMs: Math.max(0, Date.now() - startedAt),
      }
    }
  }
}

/**
 * 创建原生回收器。
 *
 * 任何一步失败都不会把异常抛给调用方，而是退化成 available:false 的降级回收器，
 * 这样上层可以照常展示「本平台暂不支持原生回收」，而不是整个插件挂掉。
 *
 * @param {{platform?: string, loadKoffi?: () => Promise<object>, logger?: object}} [options]
 *   - platform：覆盖 process.platform，给测试用。
 *   - loadKoffi：覆盖 koffi 的加载方式，给测试注入假 koffi 用。
 *   - logger：可选日志器，只用到 warn。
 * @returns {Promise<Trimmer>} 回收器实例。
 */
export async function createTrimmer(options = {}) {
  const platform = typeof options.platform === 'string' && options.platform !== '' ? options.platform : process.platform
  const logger = options.logger
  const factory = PLATFORM_STRATEGIES.get(platform)

  // 未知平台连 koffi 都不用加载——省掉一次无意义的动态 import。
  if (factory === undefined) {
    const detail = `本平台暂不支持原生回收（platform=${platform}）`
    logger?.warn?.(detail)
    return createUnsupportedTrimmer(detail)
  }

  let koffi
  try {
    // koffi 懒加载：只有真的要回收时才付加载代价，加载失败也不影响插件启动。
    const loaded = typeof options.loadKoffi === 'function' ? await options.loadKoffi() : await import('koffi')
    koffi = normalizeKoffi(loaded)
    if (koffi === null) throw new Error('koffi 模块没有可用的 load()')
  } catch (error) {
    const detail = `koffi 加载失败：${error instanceof Error ? error.message : String(error)}`
    logger?.warn?.(detail)
    return createUnsupportedTrimmer(detail)
  }

  let strategy
  try {
    strategy = factory(koffi)
  } catch (error) {
    const detail = `原生回收策略初始化失败：${error instanceof Error ? error.message : String(error)}`
    logger?.warn?.(detail)
    return createUnsupportedTrimmer(detail)
  }

  if (strategy === undefined || strategy === null || !strategy.available) {
    const detail = strategy?.detail ?? '本平台暂不支持原生回收'
    logger?.warn?.(detail)
    return createUnsupportedTrimmer(detail)
  }

  return {
    available: true,
    name: strategy.name,
    kind: strategy.kind ?? 'reclaim',
    detail: strategy.detail,
    trim: createTrimRunner(strategy.nativeTrim, strategy.nativeReturnsBytes === true),
  }
}
