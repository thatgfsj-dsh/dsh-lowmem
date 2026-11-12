/**
 * dsh-lowmem — 降低 DeepSeek Harness 宿主的常驻内存占用。
 *
 * 宿主进程跑久了 RSS 会一路涨（实测 10.7 小时后 1.8–2.7 GiB），
 * 但**根因不是 JS 对象泄漏**：强制 GC 只能回收 9 MB，
 * 真正的元凶是 glibc malloc arena 的碎片（实测 `malloc_trim(0)` 一次能还 925 MB）。
 *
 * 本插件分两层：
 * 1. **L1 原生分配器回收**（本文件与 src/host/trim/）：定时在合适的时机把
 *    碎片还给操作系统。Linux 走 `malloc_trim(0)`，macOS 走
 *    `malloc_zone_pressure_relief`，Windows 走 `EmptyWorkingSet`，
 *    全部经 koffi FFI 调用，**不编译任何原生代码**；
 * 2. **L2 配置层收紧**（cordis.patch.yml）：收紧几个官方行里"按条数不按字节"
 *    的保留上限 —— 轨迹面板的工具结果缓存，以及官方 Inspector 的 fetch journal。
 *
 * ⚠️ **更根本的办法在启动环境层**：以 `MALLOC_MMAP_THRESHOLD_=131072` 启动宿主，
 * glibc 就不会动态抬高 mmap 阈值去制造 arena 碎片。实测峰值 RSS 726–1097 MiB → 175 MiB，
 * 可回收碎片 543–928 MiB → 8 MiB，trim 耗时 22–42 ms → 0.7–1.3 ms（5 次重复）。
 * 本插件会在设置页里检测并提示。详见 docs/CONTRACT.md §6。
 *
 * 依赖注入只声明 `connection`（提供已鉴权的 Fetch 路由）；
 * 其它服务一律用 `ctx.get()` 现取，取不到就降级。
 * 不 import 任何 `@deepseek-ai/*` 包：只用 Node 内置模块、`koffi` 与本仓库相对路径。
 *
 * @module dsh-lowmem
 */
import { json, readJsonBody, withErrors } from './src/host/http.mjs'
import { createController } from './src/host/controller.mjs'

/** Cordis 插件名。 */
export const name = 'dsh-lowmem'

/** 路由前缀。 */
const BASE = '/api/dsh-lowmem'

/**
 * 挂载宿主半边。
 * @param {object} ctx - 宿主插件上下文。
 * @param {Record<string, unknown>} [config] - 行内配置（cordis.patch.yml 里写的）。
 * @returns {void}
 */
export function apply(ctx, config) {
  // ctx.logger 是可调用的（cordis 的 createCallable）：用命名空间把日志收拢到本插件名下，
  // 免得和宿主的其它日志混在一起看不出是谁打的。
  const logger = typeof ctx.logger === 'function' ? ctx.logger('dsh-lowmem') : ctx.logger
  // agents 是可选的：拿不到就退化成纯事件驱动的活跃判定。
  const agents = ctx.get('agents')
  const controller = createController({ logger, rowConfig: config, agents })

  ctx.inject(['connection'], (scoped) => {
    scoped.effect(() => scoped.connection.fetch.register({
      path: `${BASE}/stats`,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: withErrors(async () => json(200, { ok: true, ...controller.getStats() })),
    }), 'lowmem: stats 路由')

    // 同一个 path 只能注册一条路由：宿主对同一 path 重复注册会抛错，而这个 effect 一抛错，
    // 整个 scoped fiber 会被拆掉，连带把前面已经注册好的路由一起注销掉（表现为全部 404）。
    // 所以 GET 与 PUT 合并到同一条路由的 methods 里，由 method 分派。
    scoped.effect(() => scoped.connection.fetch.register({
      path: `${BASE}/config`,
      methods: ['GET', 'PUT'],
      requestBody: 'buffered',
      fetch: withErrors(async (request) => {
        if (request.method === 'GET') return json(200, { ok: true, config: controller.getConfig() })
        const body = await readJsonBody(request)
        const result = await controller.setConfig(body)
        return json(200, result)
      }),
    }), 'lowmem: config 路由')

    scoped.effect(() => scoped.connection.fetch.register({
      path: `${BASE}/trim`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: withErrors(async (request) => {
        const body = await readJsonBody(request)
        const result = await controller.trimNow(body.force === true)
        return json(200, { ok: result.ok !== false, ...result })
      }),
    }), 'lowmem: trim 路由')

    // 采样循环随插件生命周期起停：插件卸载时必须停掉定时器，
    // 否则宿主里会留下一个永不释放的 interval。
    scoped.effect(() => {
      // start() 内部已经逐段兜底；这里再挂一次 catch，纯粹是防未处理的 rejection
      // 在宿主里冒出来（没人 await 它）。
      void controller.start().catch((error) => {
        logger?.warn?.(`dsh-lowmem: 采样循环启动失败：${error instanceof Error ? error.message : String(error)}`)
      })
      return () => controller.stop()
    }, 'lowmem: 采样循环')
  })

  // 任何工具活动都算"活跃"：回收要在会话空闲时做，
  // 否则会拖慢正在跑的那一轮。
  //
  // `tools/result` 是 emit（观察者），返回值被忽略；`tools/pre-execute` 是
  // waterfall（middleware），必须调用 next() 把决策继续传给下游。少了 next()
  // 会否决整条链，宿主拿到的 gate 变成 undefined，随后读 gate.kind 直接抛
  // `Cannot read properties of undefined (reading 'kind')` —— 表现为每一个
  // 工具调用都失败（连 run_code 里的 return 1+1 也跑不了）。
  const noteActivity = () => {
    try {
      controller.noteActivity()
    } catch {
      // 记账只是给回收策略判断"现在忙不忙"用，坏了也不该有任何外部可见影响。
    }
  }
  ctx.on('tools/result', noteActivity, { global: true })
  ctx.on('tools/pre-execute', (_exec, next) => {
    noteActivity()
    return next()
  }, { global: true })

  // 精确的活跃信号：agent/status 的 status 是 'idle' | 'running'
  // （dsh-agent/lib/types/runtime-types.d.ts:115）。
  // 之前用"最近 30 秒有没有工具活动"近似，会把长时间流式回合误判成空闲。
  ctx.on('agent/status', (payload) => {
    try {
      controller.applyAgentStatus(payload?.status)
    } catch {
      // 同上：判定失败不该影响会话。
    }
  }, { global: true })

  // 自然结束（agent 或 session 被销毁）后稍等一下就回收一次。
  // 延迟 1.5 s 是为了避开正在落盘的 flush。
  ctx.on('agent/disposed', () => {
    try {
      controller.noteActivity()
    } catch { /* 同上 */ }
  }, { global: true })
  ctx.on('session/disposed', () => {
    try {
      controller.noteActivity()
    } catch { /* 同上 */ }
  }, { global: true })
}
