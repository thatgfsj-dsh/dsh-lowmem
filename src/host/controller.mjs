/**
 * 运行时控制器：持有配置与回收统计，驱动采样循环，按策略触发原生回收。
 *
 * 这一层不碰 HTTP，也不碰 cordis 事件，方便单测。
 *
 * @module dsh-lowmem/host/controller
 */
import { createTrimmer } from './trim/index.mjs'
import { sampleMemory } from './sampler.mjs'
import { decideTrim } from './policy.mjs'
import { runGc } from './gc.mjs'
import { createActivityTracker } from './activity.mjs'
import { DEFAULT_CONFIG, mergeConfig, readSettings, writeSettings } from './settings.mjs'

/** 推荐的环境变量：以它启动可从根上避免 arena 碎片形成。 */
export const RECOMMENDED_ENV = 'MALLOC_MMAP_THRESHOLD_=131072'

/**
 * 宿主是不是已经按推荐配置启动。
 *
 * 实测（同一工作负载，5 次重复）：
 * - 默认：峰值 RSS 726–1097 MiB，可回收碎片 543–928 MiB，trim 耗时 22–42 ms；
 * - `MALLOC_MMAP_THRESHOLD_=131072`：峰值 RSS 175 MiB，可回收碎片 8 MiB，trim 耗时 0.7–1.3 ms。
 * 也就是峰值 RSS -80%、碎片 -98%。
 *
 * 这个变量属 **bootstrap-only** 名，不能写进 .env（dsh-app-boot/lib/index.js:4360,4440），
 * 只能由启动环境给。
 * @returns {boolean} 是否已按推荐配置启动。
 */
export function isAllocatorTuned() {
  const value = process.env.MALLOC_MMAP_THRESHOLD_
  if (value === undefined) return false
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric > 0 && numeric <= 1024 * 1024
}

/**
 * 创建控制器。
 * @param {{logger?: object, rowConfig?: Record<string, unknown>, agents?: object|null}} options - 依赖与行内配置。
 * @returns {object} 控制器。
 */
export function createController(options = {}) {
  const logger = options.logger
  /** 行内配置（cordis.patch.yml 里写的）优先级低于磁盘上的用户设置。 */
  let config = mergeConfig(DEFAULT_CONFIG, options.rowConfig ?? {})
  /** 用户显式改过的键（只落盘差量，避免上游默认值被本地旧值粘住）。 */
  const overrides = {}

  /** 回收统计。 */
  const stats = {
    count: 0,
    totalRssDeltaBytes: 0,
    lastRssDeltaBytes: 0,
    lastNativeReleasedBytes: null,
    lastDurationMs: 0,
    lastAt: 0,
    lastReason: null,
    lastError: null,
    byReason: { threshold: 0, idle: 0, 'hard-cap': 0, manual: 0 },
  }

  /** 上次回收后的 RSS；未回收过时用启动时的 RSS。 */
  let lastTrimRssBytes = sampleMemory().rssBytes
  /** 原生回收器；加载完成前为 null。 */
  let trimmer = null
  /** 采样定时器句柄。 */
  let timer = null
  /** 是否已经停过（避免 dispose 时重复 stop）。 */
  let stopped = false
  /** 启动中的 Promise：防止并发 start() 建出两个 interval。 */
  let starting = null
  /** 是否正在执行一次回收（防止 tick 与手动请求叠在一起）。 */
  let inFlight = false

  const activity = createActivityTracker({ agents: options.agents ?? null })

  /**
   * 记一次回收结果。
   * @param {boolean} ok - 是否成功。
   * @param {number} rssDeltaBytes - RSS 净变化。
   * @param {number|null} nativeReleasedBytes - 原生自报的释放量。
   * @param {number} durationMs - 耗时。
   * @param {string} reason - 触发理由。
   * @param {string} [error] - 失败原因。
   */
  function recordTrim(ok, rssDeltaBytes, nativeReleasedBytes, durationMs, reason, error) {
    stats.count += 1
    stats.lastRssDeltaBytes = rssDeltaBytes
    stats.lastNativeReleasedBytes = nativeReleasedBytes
    stats.lastDurationMs = durationMs
    stats.lastAt = Date.now()
    stats.lastReason = reason
    stats.lastError = error ?? null
    if (ok) stats.totalRssDeltaBytes += rssDeltaBytes
    if (Object.prototype.hasOwnProperty.call(stats.byReason, reason)) {
      stats.byReason[reason] += 1
    }
  }

  /**
   * 执行一次回收（不经过策略判定）。
   * @param {string} reason - 触发理由。
   * @returns {Promise<object>} 回收结果。
   */
  async function performTrim(reason) {
    // 并发保护：tick 与手动请求可能撞在一起。malloc_trim 本身是同步阻塞的，
    // 这里再叠一个标志位，保证统计不会重复计入、阈值基线不会被两个调用互相覆盖。
    if (inFlight) {
      return { ok: false, skipped: true, reason: 'in-flight' }
    }
    inFlight = true
    try {
      const before = sampleMemory()
      if (!trimmer || !trimmer.available) {
        const detail = trimmer ? trimmer.detail : '原生回收器尚未就绪'
        recordTrim(false, 0, null, 0, reason, detail)
        return {
          ok: false,
          skipped: true,
          reason: 'unavailable',
          rssDeltaBytes: 0,
          nativeReleasedBytes: null,
          durationMs: 0,
          before: { rssBytes: before.rssBytes },
          after: { rssBytes: before.rssBytes },
          mechanism: { available: false, name: null, kind: null, detail },
        }
      }
      const outcome = trimmer.trim({ rssBytes: before.rssBytes })
      const after = sampleMemory()
      const rssDeltaBytes = Math.max(0, outcome.rssDeltaBytes ?? 0)
      recordTrim(outcome.ok, rssDeltaBytes, outcome.nativeReleasedBytes ?? null, outcome.durationMs ?? 0, reason, outcome.error)
      if (!outcome.ok) {
        logger?.warn?.(`dsh-lowmem: 回收失败：${outcome.error ?? '未知原因'}`)
      } else {
        // **只有成功才更新阈值基线**。失败时若也更新，"增长量"会被清零，
        // 可能导致之后长时间再也不触发。
        lastTrimRssBytes = after.rssBytes
      }
      if (config.gcEnabled) {
        const gcResult = runGc(config.gcMode)
        if (!gcResult.ok) {
          logger?.warn?.(`dsh-lowmem: GC 未执行：${gcResult.error ?? '未知原因'}`)
        }
      }
      return {
        ok: outcome.ok,
        rssDeltaBytes,
        nativeReleasedBytes: outcome.nativeReleasedBytes ?? null,
        durationMs: outcome.durationMs ?? 0,
        before: { rssBytes: before.rssBytes },
        after: { rssBytes: after.rssBytes },
        mechanism: {
          available: trimmer.available,
          name: trimmer.name,
          kind: trimmer.kind ?? null,
          detail: trimmer.detail,
        },
      }
    } finally {
      inFlight = false
    }
  }

  /**
   * 跑一轮策略判定。
   */
  async function tick() {
    if (stopped) return
    try {
      const now = Date.now()
      activity.reconcile()
      const memory = sampleMemory()
      const state = {
        rssBytes: memory.rssBytes,
        lastTrimAt: stats.lastAt,
        lastTrimRssBytes,
        activeTurn: activity.isBusy(),
        lastActivityAt: activity.lastActivityAt(),
      }
      const decision = decideTrim(state, config, now)
      if (!decision.should) return
      await performTrim(decision.reason)
    } catch (error) {
      logger?.warn?.(`dsh-lowmem: 采样轮次失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * 启动采样循环与原生回收器。
   * @returns {Promise<void>} 启动完成。
   */
  async function start() {
    if (timer !== null) return
    if (starting !== null) return starting
    starting = (async () => {
      config = mergeConfig(config, await readSettings({}))
      try {
        trimmer = await createTrimmer({ logger })
      } catch (error) {
        trimmer = null
        logger?.warn?.(
          `dsh-lowmem: 原生回收器不可用：${error instanceof Error ? error.message : String(error)}`,
        )
      }
      if (stopped) return
      const interval = Math.max(1000, Number(config.sampleIntervalMs) || 15_000)
      timer = setInterval(() => {
        void tick()
      }, interval)
      // 定时器不该拖住宿主退出。
      if (typeof timer.unref === 'function') timer.unref()
    })()
    try {
      await starting
    } finally {
      starting = null
    }
  }

  /**
   * 停止采样循环。
   */
  function stop() {
    stopped = true
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  /**
   * 统计快照（给 /stats 用）。
   * @returns {object} 统计信息。
   */
  function getStats() {
    const memory = sampleMemory()
    return {
      platform: process.platform,
      mechanism: {
        available: Boolean(trimmer?.available),
        name: trimmer?.name ?? null,
        kind: trimmer?.kind ?? null,
        detail: trimmer?.detail ?? '原生回收器尚未就绪',
      },
      memory,
      trim: { ...stats, byReason: { ...stats.byReason } },
      activity: {
        running: activity.isBusy(),
        activeAgents: activity.runningAgentCount(),
        activeJobs: 0,
      },
      allocator: {
        mmapThresholdPinned: isAllocatorTuned(),
        recommendedEnv: RECOMMENDED_ENV,
      },
      config: { ...config },
    }
  }

  /**
   * 读取当前配置。
   * @returns {object} 配置副本。
   */
  function getConfig() {
    return { ...config }
  }

  /**
   * 更新配置并落盘。
   *
   * 只把**用户显式改过的键**写盘，这样上游改了行的默认配置后本机仍能拿到新默认值。
   * @param {Record<string, unknown>} patch - 配置补丁。
   * @returns {Promise<{ok: boolean, config: object, persisted: boolean}>} 更新结果。
   */
  async function setConfig(patch) {
    if (patch === null || typeof patch !== 'object') {
      return { ok: false, config: { ...config }, persisted: false }
    }
    config = mergeConfig(config, patch)
    for (const key of Object.keys(patch)) {
      if (Object.prototype.hasOwnProperty.call(config, key)) overrides[key] = config[key]
    }
    const persisted = await writeSettings(overrides)
    if (!persisted) {
      // 写盘失败要让调用方知道，别让 UI 显示"已保存"。
      return { ok: false, config: { ...config }, persisted: false }
    }
    return { ok: true, config: { ...config }, persisted: true }
  }

  /**
   * 立即回收一次。
   * @param {boolean} force - 是否忽略策略判定强制执行。
   * @returns {Promise<object>} 回收结果。
   */
  async function trimNow(force) {
    if (!force) {
      const now = Date.now()
      activity.reconcile()
      const memory = sampleMemory()
      const decision = decideTrim(
        {
          rssBytes: memory.rssBytes,
          lastTrimAt: stats.lastAt,
          lastTrimRssBytes,
          activeTurn: activity.isBusy(),
          lastActivityAt: activity.lastActivityAt(),
        },
        config,
        now,
      )
      if (!decision.should) {
        return { ok: false, skipped: true, reason: decision.reason }
      }
      return await performTrim(decision.reason)
    }
    return await performTrim('manual')
  }

  return {
    start,
    stop,
    tick,
    getStats,
    getConfig,
    setConfig,
    trimNow,
    noteActivity: activity.noteActivity,
    applyAgentStatus: activity.applyStatus,
    activity,
  }
}
