/**
 * 客户端单测用的假宿主环境：假 React、假 fetch、假 ctx、渲染辅助。
 *
 * 单独成文件是为了让 tests/client.test.mjs 控制在 400 行以内（仓库规矩：单文件 ≤ 400 行）。
 * 这里只提供「怎么把 bundle 跑起来」的手段，不放断言。
 */
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import { buildClient } from '../../scripts/build-client.mjs'

/** 契约 v2 的内存快照样例（glibc / reclaim）。 */
export const STATS_FIXTURE = {
  ok: true,
  platform: 'linux',
  mechanism: { available: true, name: 'malloc_trim', kind: 'reclaim', detail: 'glibc malloc_trim(0)' },
  memory: {
    rssBytes: 1610612736, heapTotalBytes: 665174016, heapUsedBytes: 517361360,
    externalBytes: 50926115, arrayBufferBytes: 38197831, uptimeSeconds: 38664, pid: 1427847,
    rssPeakBytes: 1803550720, heapResidentBytes: 268435456,
  },
  trim: {
    count: 3, totalRssDeltaBytes: 925000000, lastRssDeltaBytes: 168000000,
    lastNativeReleasedBytes: null, lastDurationMs: 19, lastAt: 1786545516616,
    lastReason: 'threshold', lastError: null,
    byReason: { threshold: 2, idle: 1, 'hard-cap': 0, manual: 0 },
  },
  activity: { running: true, activeAgents: 2, activeJobs: 1 },
  allocator: { mmapThresholdPinned: false, recommendedEnv: 'MALLOC_MMAP_THRESHOLD_=131072', recommendation: '固定 glibc 的 mmap 阈值' },
  config: { enabled: true, thresholdBytes: 268435456, minIntervalMs: 60000, idleIntervalMs: 300000, hardCapBytes: 3221225472, sampleIntervalMs: 15000 },
}

/** 一个假的 React：够跑 hooks、够渲染出元素树。 */
export function createReactHarness() {
  const hooks = []
  const effects = []
  const harness = {
    hooks, effects, cursor: 0,
    reset() { harness.cursor = 0 },
    react: {
      createElement(type, props, ...children) {
        const finalProps = { ...(props ?? {}) }
        if (children.length > 0) finalProps.children = children.flat(Infinity)
        return { type, props: finalProps, children: finalProps.children ?? [] }
      },
      useState(initial) {
        const index = harness.cursor++
        if (!(index in hooks)) hooks[index] = { value: typeof initial === 'function' ? initial() : initial }
        const slot = hooks[index]
        return [slot.value, next => { slot.value = typeof next === 'function' ? next(slot.value) : next }]
      },
      useRef(initial) {
        const index = harness.cursor++
        if (!(index in hooks)) hooks[index] = { current: initial }
        return hooks[index]
      },
      useEffect(fn) { effects.push(fn) },
      Component: class { constructor(props) { this.props = props; this.state = {} } },
    },
  }
  return harness
}

/** 把元素树里的函数组件与类组件都跑起来。 */
export function materialize(node, harness) {
  if (node === null || node === undefined || typeof node === 'boolean') return node
  if (typeof node === 'string' || typeof node === 'number') return node
  if (Array.isArray(node)) return node.map(item => materialize(item, harness))
  if (typeof node.type === 'function') {
    if (node.type.prototype && typeof node.type.prototype.render === 'function') {
      const instance = new node.type(node.props)
      instance.props = node.props
      return materialize(instance.render(), harness)
    }
    harness.reset()
    return materialize(node.type(node.props), harness)
  }
  if (Array.isArray(node.children)) return { type: node.type, props: node.props, children: node.children.map(item => materialize(item, harness)) }
  return node
}

/** 渲染一次：返回展开后的元素树。 */
export function renderTree(harness, component, props) {
  harness.effects.length = 0
  harness.reset()
  return materialize(component(props ?? {}), harness)
}

/** 元素树里的纯文本。 */
export function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (Array.isArray(node.children)) return node.children.map(textOf).join(' ')
  return ''
}

/** 找出所有满足条件的元素。 */
export function findAll(node, predicate, found = []) {
  if (node === null || node === undefined || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const item of node) findAll(item, predicate, found)
    return found
  }
  if (predicate(node)) found.push(node)
  if (Array.isArray(node.children)) for (const item of node.children) findAll(item, predicate, found)
  return found
}

/** 造一个假的 fetch，并记录所有请求。 */
export function createFetchStub(routes) {
  const calls = []
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body ?? null })
    const handler = routes[String(url)]
    if (handler === undefined) return { ok: false, status: 404, json: async () => ({ ok: false, message: 'not found' }) }
    const request = init.body === undefined || init.body === null ? null : JSON.parse(init.body)
    const payload = typeof handler === 'function' ? await handler(request, init) : handler
    return { ok: true, status: 200, json: async () => payload }
  }
  return { fetch, calls }
}

/** 在沙箱里加载 bundle，返回模块描述对象与沙箱。 */
export async function loadClient(options = {}) {
  const source = options.source ?? await buildClient({ compact: false })
  const harness = createReactHarness()
  const timers = []
  const { fetch, calls } = createFetchStub(options.routes ?? {})
  let loaded
  const sandbox = {
    window: { __ModuleLoader__: { load: value => { loaded = value } } },
    require: name => { if (name === 'react') return harness.react; throw new Error('unexpected require: ' + name) },
    fetch, setTimeout, clearTimeout,
    setInterval(fn, ms) { timers.push({ fn, ms, cleared: false }); return timers.length },
    clearInterval(id) { const timer = timers[id - 1]; if (timer !== undefined) timer.cleared = true },
    console,
  }
  runInNewContext(source, sandbox)
  assert.ok(loaded, 'client.js 没有调用 __ModuleLoader__.load')
  return { loaded, harness, calls, timers }
}

/** 造一个假的宿主 ctx，并返回注册记录。 */
export function createCtx() {
  const registrations = []
  const dictionaries = []
  const ctx = {
    locale: {
      register: (ns, dicts) => { dictionaries.push([ns, dicts]); return () => {} },
      bind: ns => (key, params) => {
        const dicts = dictionaries.find(entry => entry[0] === ns)
        const template = dicts?.[1]?.zh?.[key] ?? dicts?.[1]?.en?.[key] ?? key
        return String(template).replace(/\{(\w+)\}/g, (match, name) => (params && name in params ? String(params[name]) : match))
      },
    },
    slots: {
      inject: (name, install) => { install() },
      register: (slotOptions, component) => { registrations.push({ options: slotOptions, component }); return () => {} },
    },
    effect: fn => { fn() },
    get: () => undefined,
  }
  return { ctx, registrations, dictionaries }
}

/** 让挂起的 promise 跑完。 */
export async function flush() {
  for (let index = 0; index < 5; index++) await new Promise(resolve => setTimeout(resolve, 0))
}

/** 挂上插件、跑一次 effect、把首屏渲染出来。 */
export async function renderSection(routes) {
  const { loaded, harness, calls, timers } = await loadClient({ routes })
  const module = loaded.factory(() => harness.react)
  const { ctx, registrations } = createCtx()
  module.apply(ctx)
  const component = registrations[0].component
  renderTree(harness, component, {})
  const cleanup = harness.effects[0]()
  await flush()
  return { harness, component, calls, timers, cleanup, tree: renderTree(harness, component, {}) }
}

/** 「立即回收」旁边的提示文案（只看提示本身，不含面板里的其它文字）。 */
export function noticeText(harness, component) {
  const node = findAll(renderTree(harness, component, {}), item => item.props?.key === 'notice')[0]
  return node === undefined ? '' : textOf(node)
}

/** 标准的三个接口。 */
export function routesFor(stats) {
  return {
    '/api/dsh-lowmem/stats': stats,
    // 配置接口像真宿主那样：GET 回当前配置，PUT 回显刚提交的配置。
    '/api/dsh-lowmem/config': request => (request === null ? { ok: true, config: STATS_FIXTURE.config } : { ok: true, config: request }),
    '/api/dsh-lowmem/trim': {
      ok: true, rssDeltaBytes: 168000000, nativeReleasedBytes: null, durationMs: 19,
      before: { rssBytes: 1610612736 }, after: { rssBytes: 1442612736 },
      mechanism: { available: true, name: 'malloc_trim', kind: 'reclaim', detail: 'glibc malloc_trim(0)' },
    },
  }
}

/** 断言文本里要出现这些片段。 */
export function assertHas(text, patterns) {
  for (const pattern of patterns) assert.match(text, pattern)
}
