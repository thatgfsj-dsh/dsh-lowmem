/**
 * 回收触发策略：纯函数，无 IO、无计时器，可以直接单测。
 *
 * 设计取舍：
 * - **硬上限优先**：RSS 已经离谱时不等空闲、不等间隔，先还内存再说；
 * - **阈值要空闲**：正在跑会话时回收会拖慢那一轮，所以阈值路径要求当前没有活跃轮次；
 * - **空闲兜底**：长时间没人用也要还内存，即使增长没到阈值；
 * - **最小间隔**：防止在高频采样下反复 trim（每次 trim 都要走一次 FFI 与内核交互）。
 *
 * @module dsh-lowmem/host/policy
 */

/**
 * @typedef {object} TrimConfig
 * @property {boolean} enabled 是否启用自动回收。
 * @property {number} thresholdBytes 相对上次回收后的 RSS 增长超过该值才回收。
 * @property {number} minIntervalMs 两次回收之间的最小间隔（毫秒）。
 * @property {number} idleIntervalMs 空闲多久后兜底回收（毫秒）。
 * @property {number} hardCapBytes RSS 超过该值立即回收。
 * @property {number} sampleIntervalMs 采样周期（毫秒）。
 */

/**
 * @typedef {object} TrimState
 * @property {number} rssBytes 当前 RSS。
 * @property {number} lastTrimAt 上次回收时间戳（epoch 毫秒），没有则 0。
 * @property {number} lastTrimRssBytes 上次回收后的 RSS。
 * @property {boolean} activeTurn 当前是否有正在跑的会话轮次。
 * @property {number} lastActivityAt 上次活动时间戳（epoch 毫秒）。
 */

/**
 * @typedef {object} TrimDecision
 * @property {boolean} should 是否应当执行一次回收。
 * @property {string} reason 判定理由（稳定的机器可读标识）。
 */

/**
 * 判定此刻是否应当回收内存。
 * @param {TrimState} state - 当前状态。
 * @param {TrimConfig} config - 配置。
 * @param {number} now - 当前时间戳（epoch 毫秒）。
 * @returns {TrimDecision} 判定结果。
 */
export function decideTrim(state, config, now) {
  if (!config.enabled) return { should: false, reason: 'disabled' }
  if (state.rssBytes >= config.hardCapBytes) return { should: true, reason: 'hard-cap' }
  const sinceTrim = now - state.lastTrimAt
  const grew = state.rssBytes - state.lastTrimRssBytes
  if (grew >= config.thresholdBytes && sinceTrim >= config.minIntervalMs && !state.activeTurn) {
    return { should: true, reason: 'threshold' }
  }
  if (now - state.lastActivityAt >= config.idleIntervalMs && sinceTrim >= config.minIntervalMs) {
    return { should: true, reason: 'idle' }
  }
  return { should: false, reason: 'below-threshold' }
}
