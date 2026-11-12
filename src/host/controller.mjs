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
import { DEFAULT_CONFIG, mergeConfig, readSettings, writeSettings } from './settings.mjs'

/** 活跃判定窗口：这段时间内有过工具活动，就认为可能有会话在跑。 */
const ACTIVE_WINDOW_MS = 30_000

/**
 * 创建控制器。
 * @param {{logger?: object, rowConfig?: Record<string, unknown>}} options - 依赖与行内配置。
 * @returns {object} 控制器。
 */
export function createController(options = {}) {
  const logger = options.logger
  /** 行内配置（cordis.patch.yml 里写的）优先级低于磁盘上的用户设置。 */
  let config = mergeConfig(DEFAULT_CONFIG, options.rowConfig ?? {})

  /** 回收统计。 */
  const stats = {
    count: 0,
    totalReclaimedBytes: 0,
    lastReclaimedBytes: 0,
    lastDurationMs: 0,
    lastAt: 0,
    lastReason: null,
    lastError: null,
  }

  /** 上次回收后的 RSS；未回收过时用启动时的 RSS。 */
  let lastTrimRssBytes = sampleMemory().rssBytes
  /** 上次活动时间戳。 */
  let lastActivityAt = Date.now()
  /** 原生回收器；加载完成前为 null。 */
  let trimmer = null
  /** 采样定时器句柄。 */
  let timer = null
  /** 是否已经停过（避免 dispose 时重复 stop）。 */
  let stopped = false

  /**
   * 记一笔活动（任何工具活动都算）。
   */
  function noteActivity() {
    lastActivityAt = Date.now()
  }

  /**
   * 记一次回收结果。
   * @param {boolean} ok - 是否成功。
   * @param {number} reclaimedBytes - 释放字节数。
   * @param {number} durationMs - 耗时。
   * @param {string} reason - 触发理由。
   * @param {string} [error] - 失败原因。
   */
  function recordTrim(ok, reclaimedBytes, durationMs, reason, error) {
    stats.count += 1
    stats.lastReclaimedBytes = reclaimedBytes
    stats.lastDurationMs = durationMs
    stats.lastAt = Date.now()
    stats.lastReason = reason
    stats.lastError = error ?? null
    if (ok) stats.totalReclaimedBytes += reclaimedBytes
  }

  /**
   * 执行一次回收（不经过策略判定）。
   * @param {string} reason - 触发理由。
   * @returns {Promise<object>} 回收结果。
   */
  async function performTrim(reason) {
    const before = sampleMemory()
    if (!trimmer || !trimmer.available) {
      const detail = trimmer ? trimmer.detail : '原生回收器尚未就绪'
      recordTrim(false, 0, 0, reason, detail)
      return {
        ok: false,
        reclaimedBytes: 0,
        durationMs: 0,
        before: { rssBytes: before.rssBytes },
        after: { rssBytes: before.rssBytes },
        mechanism: { available: false, name: null, detail },
      }
    }
    // 把采样到的 RSS 作为基线传给 trimmer，让它算出的释放量与 before/after 同源。
    const outcome = trimmer.trim({ rssBytes: before.rssBytes })
    const after = sampleMemory()
    const reclaimedBytes = Math.max(0, outcome.reclaimedBytes ?? 0)
    recordTrim(outcome.ok, reclaimedBytes, outcome.durationMs ?? 0, reason, outcome.error)
    if (!outcome.ok) {
      logger?.warn?.(`dsh-lowmem: 回收失败：${outcome.error ?? '未知原因'}`)
    }
    if (config.gcEnabled) {
      const gcResult = runGc(config.gcMode)
      if (!gcResult.ok) {
        logger?.warn?.(`dsh-lowmem: GC 未执行：${gcResult.error ?? '未知原因'}`)
      }
    }
    lastTrimRssBytes = after.rssBytes
    return {
      ok: outcome.ok,
      reclaimedBytes,
      durationMs: outcome.durationMs ?? 0,
      before: { rssBytes: before.rssBytes },
      after: { rssBytes: after.rssBytes },
      mechanism: { available: trimmer.available, name: trimmer.name, detail: trimmer.detail },
    }
  }

  /**
   * 跑一轮策略判定。
   */
  async function tick() {
    if (stopped) return
    try {
      const now = Date.now()
      const memory = sampleMemory()
      const state = {
        rssBytes: memory.rssBytes,
        lastTrimAt: stats.lastAt,
        lastTrimRssBytes,
        activeTurn: now - lastActivityAt < ACTIVE_WINDOW_MS,
        lastActivityAt,
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
    if (timer) return
    config = await readSettings(config)
    try {
      trimmer = await createTrimmer({ logger })
    } catch (error) {
      trimmer = null
      logger?.warn?.(
        `dsh-lowmem: 原生回收器不可用：${error instanceof Error ? error.message : String(error)}`,
      )
    }
    const interval = Math.max(1000, Number(config.sampleIntervalMs) || 15_000)
    timer = setInterval(() => {
      void tick()
    }, interval)
    // 定时器不该拖住宿主退出。
    if (typeof timer.unref === 'function') timer.unref()
  }

  /**
   * 停止采样循环。
   */
  function stop() {
    stopped = true
    if (timer) {
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
        detail: trimmer?.detail ?? '原生回收器尚未就绪',
      },
      memory,
      trim: { ...stats },
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
   * @param {Record<string, unknown>} patch - 配置补丁。
   * @returns {Promise<{ok: boolean, config: object, persisted: boolean}>} 更新结果。
   */
  async function setConfig(patch) {
    config = mergeConfig(config, patch)
    const persisted = await writeSettings(config)
    return { ok: true, config: { ...config }, persisted }
  }

  /**
   * 立即回收一次。
   * @param {boolean} force - 是否忽略策略判定强制执行。
   * @returns {Promise<object>} 回收结果。
   */
  async function trimNow(force) {
    if (!force) {
      const now = Date.now()
      const memory = sampleMemory()
      const decision = decideTrim(
        {
          rssBytes: memory.rssBytes,
          lastTrimAt: stats.lastAt,
          lastTrimRssBytes,
          activeTurn: now - lastActivityAt < ACTIVE_WINDOW_MS,
          lastActivityAt,
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
    noteActivity,
  }
}
