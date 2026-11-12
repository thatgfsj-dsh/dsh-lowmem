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
 * 2. **L2 配置层收紧**（cordis.patch.yml）：把官方插件里几个"按条数不按字节"
 *    的保留上限调小，例如 `ui-trajectory.maxResultsPerSession` 默认 1000，
 *    实测在活体宿主里就占 54.68 MiB。
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
  console.log('[dsh-lowmem] apply 开始：等待 connection 服务就绪')
  const controller = createController({ logger: ctx.logger, rowConfig: config })

  ctx.inject(['connection'], (scoped) => {
    scoped.effect(() => scoped.connection.fetch.register({
      path: `${BASE}/stats`,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: withErrors(async () => json(200, { ok: true, ...controller.getStats() })),
    }), 'lowmem: stats 路由')

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

    // 同一个 path 只能注册一次：重复注册会让 register() 抛错，而这个 effect 一抛错，
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

    // 采样循环随插件生命周期起停：插件卸载时必须停掉定时器，
    // 否则宿主里会留下一个永不释放的 interval。
    scoped.effect(() => {
      // start() 内部已经逐段兜底；这里再挂一次 catch，纯粹是防未处理的 rejection
      // 在宿主里冒出来（没人 await 它）。
      void controller.start().catch((error) => {
        ctx.logger?.warn?.(`dsh-lowmem: 采样循环启动失败：${error instanceof Error ? error.message : String(error)}`)
      })
      return () => controller.stop()
    }, 'lowmem: 采样循环')
  })

  // 任何工具活动都算"活跃"：回收要在会话空闲时做，
  // 否则会拖慢正在跑的那一轮。
  // 记账失败绝不能影响工具链：waterfall 里的下一环是整条调用路径，
  // 自己抛错等于把用户的工具调用弄挂。所以两处都兜一层 try/catch。
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
}
