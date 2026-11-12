/**
 * 活跃度追踪：判断"现在宿主忙不忙"。
 *
 * 为什么要精确信号：之前用"最近 30 秒内有没有工具活动"来近似，
 * 但一次长时间流式 LLM 回合（没有工具调用）会被误判成空闲，
 * 于是插件可能在用户正忙的时候去 trim。
 *
 * 宿主提供了精确信号（都是 emit 语义，见 docs/CONTRACT.md §2.6）：
 * - `agent/status`：载荷 `{ agent, status }`，status 是 'idle' | 'running'
 *   （dsh-agent/lib/types/runtime-types.d.ts:115,279-282；emit 点 dsh-agent-loop/lib/index.js:562）；
 * - `agent/disposed`：agent 消失（dsh-agent/lib/index.js:678-690）；
 * - `session/disposed`：会话消失（dsh-session/lib/index.js:1949-1952）。
 *
 * 宿主自己判断空闲的写法可以直接抄：`agent.status === 'idle'`
 * （见 dsh-goal-round-driver/lib/index.js:85、dsh-subagent/lib/index.js:1307）。
 *
 * @module dsh-lowmem/host/activity
 */

/**
 * 创建活跃度追踪器。
 *
 * @param {{agents?: object|null}} options - 可选的宿主服务（拿不到就退化成事件驱动）。
 * @returns {object} 追踪器。
 */
export function createActivityTracker(options = {}) {
  /** 正在 running 的 agent 数量。 */
  let runningAgents = 0
  /** 上次活动时间戳（epoch 毫秒）。 */
  let lastActivityAt = Date.now()

  /**
   * 记一次活动。
   */
  function noteActivity() {
    lastActivityAt = Date.now()
  }

  /**
   * 处理 agent 状态变化。
   * @param {string} status - 'idle' | 'running'。
   */
  function applyStatus(status) {
    if (status === 'running') {
      runningAgents += 1
      noteActivity()
    } else if (runningAgents > 0) {
      runningAgents -= 1
      noteActivity()
    }
  }

  /**
   * 用宿主服务里的真实状态校准计数（事件可能漏，用 list() 兜底）。
   */
  function reconcile() {
    const agents = options.agents
    if (agents === undefined || agents === null) return
    try {
      const list = agents.list?.()
      if (!Array.isArray(list)) return
      const running = list.filter((agent) => agent?.status !== 'idle').length
      runningAgents = running
    } catch {
      // 拿不到就保持现状，不影响主流程。
    }
  }

  return {
    noteActivity,
    applyStatus,
    reconcile,
    /**
     * 当前是否繁忙。
     * @returns {boolean} 有 agent 在跑就是繁忙。
     */
    isBusy() {
      return runningAgents > 0
    },
    /**
     * 活跃 agent 数。
     * @returns {number} 数量。
     */
    runningAgentCount() {
      return runningAgents
    },
    /**
     * 上次活动时间戳。
     * @returns {number} epoch 毫秒。
     */
    lastActivityAt() {
      return lastActivityAt
    },
  }
}
