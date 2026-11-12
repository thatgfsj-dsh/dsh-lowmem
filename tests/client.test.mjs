/**
 * 客户端 bundle 的结构单测：模块 id、slot 注册、词典、纯函数行为、渲染冒烟。
 *
 * 注意：这里只验证「bundle 能加载、注册了什么、渲染分支不炸」，**不代表**真实页面渲染已验收；
 * UI 渲染需要在真实浏览器里点验（见 README 的验证章节）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext, Script } from 'node:vm'
import { buildClient } from '../scripts/build-client.mjs'

/** 契约里的内存快照样例。 */
const STATS_FIXTURE = {
  platform: 'linux',
  mechanism: { available: true, name: 'malloc_trim', detail: 'glibc malloc_trim(0)' },
  memory: { rssBytes: 1610612736, heapTotalBytes: 665174016, heapUsedBytes: 517361360, externalBytes: 50926115, arrayBufferBytes: 38197831, uptimeSeconds: 38664, pid: 1427847 },
  trim: { count: 3, totalReclaimedBytes: 925000000, lastReclaimedBytes: 168000000, lastDurationMs: 19, lastAt: 1786545516616, lastReason: 'threshold', lastError: null },
  config: { enabled: true, thresholdBytes: 268435456, minIntervalMs: 60000, idleIntervalMs: 300000, hardCapBytes: 3221225472, sampleIntervalMs: 15000 },
}

/** 一个假的 React：够跑 hooks、够渲染出元素树。 */
function createReactHarness() {
  const hooks = []
  const effects = []
  const harness = {
    hooks,
    effects,
    cursor: 0,
    reset() {
      harness.cursor = 0
    },
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
        const set = next => { slot.value = typeof next === 'function' ? next(slot.value) : next }
        return [slot.value, set]
      },
      useRef(initial) {
        const index = harness.cursor++
        if (!(index in hooks)) hooks[index] = { current: initial }
        return hooks[index]
      },
      useEffect(fn) {
        effects.push(fn)
      },
      Component: class {
        constructor(props) {
          this.props = props
          this.state = {}
        }
      },
    },
  }
  return harness
}
/** 把元素树里的函数组件与类组件都跑起来。 */
function materialize(node, harness) {
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
function renderTree(harness, component, props) {
  harness.effects.length = 0
  harness.reset()
  const element = component(props ?? {})
  return materialize(element, harness)
}
/** 元素树里的纯文本。 */
function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (Array.isArray(node.children)) return node.children.map(textOf).join(' ')
  return ''
}
/** 找出所有满足条件的元素。 */
function findAll(node, predicate, found = []) {
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
function createFetchStub(routes) {
  const calls = []
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body ?? null })
    const handler = routes[String(url)]
    if (handler === undefined) return { ok: false, status: 404, json: async () => ({ ok: false, message: 'not found' }) }
    const payload = typeof handler === 'function' ? await handler() : handler
    return { ok: true, status: 200, json: async () => payload }
  }
  return { fetch, calls }
}
/** 在沙箱里加载 bundle，返回模块描述对象与沙箱。 */
async function loadClient(options = {}) {
  const source = options.source ?? await buildClient({ compact: false })
  const harness = createReactHarness()
  const timers = []
  const { fetch, calls } = createFetchStub(options.routes ?? {})
  let loaded
  const sandbox = {
    window: { __ModuleLoader__: { load: value => { loaded = value } } },
    require: name => {
      if (name === 'react') return harness.react
      throw new Error('unexpected require: ' + name)
    },
    fetch,
    setTimeout,
    clearTimeout,
    setInterval(fn, ms) {
      timers.push({ fn, ms, cleared: false })
      return timers.length
    },
    clearInterval(id) {
      const timer = timers[id - 1]
      if (timer !== undefined) timer.cleared = true
    },
    console,
  }
  runInNewContext(source, sandbox)
  assert.ok(loaded, 'client.js 没有调用 __ModuleLoader__.load')
  return { loaded, harness, calls, timers }
}

/** 造一个假的宿主 ctx，并返回注册记录。 */
function createCtx() {
  const registrations = []
  const dictionaries = []
  const ctx = {
    locale: {
      register: (ns, dicts) => {
        dictionaries.push([ns, dicts])
        return () => {}
      },
      bind: ns => (key, params) => {
        const dicts = dictionaries.find(entry => entry[0] === ns)
        const template = dicts?.[1]?.zh?.[key] ?? dicts?.[1]?.en?.[key] ?? key
        return String(template).replace(/\{(\w+)\}/g, (match, name) => (params && name in params ? String(params[name]) : match))
      },
    },
    slots: {
      inject: (name, install) => { install() },
      register: (slotOptions, component) => {
        registrations.push({ options: slotOptions, component })
        return () => {}
      },
    },
    effect: fn => { fn() },
    get: () => undefined,
  }
  return { ctx, registrations, dictionaries }
}

/** 让挂起的 promise 跑完。 */
async function flush() {
  for (let index = 0; index < 5; index++) await new Promise(resolve => setTimeout(resolve, 0))
}

test('客户端模块 id 必须等于包名', async () => {
  const { loaded, harness } = await loadClient()
  assert.equal(loaded.id, 'dsh-lowmem')
  assert.equal(typeof loaded.factory, 'function')
  assert.doesNotThrow(() => loaded.factory(() => harness.react))
})

test('apply 注册 settings.section，id / 顺序 / 词典符合契约', async () => {
  const { loaded, harness } = await loadClient()
  const module = loaded.factory(() => harness.react)
  assert.deepEqual([...module.inject], ['slots', 'locale'])
  const { ctx, registrations, dictionaries } = createCtx()
  module.apply(ctx)
  assert.equal(registrations.length, 1)
  const options = registrations[0].options
  assert.equal(options.name, 'settings.section')
  assert.equal(options.id, 'dsh-lowmem')
  assert.equal(options.locale, 'lowmem')
  assert.equal(typeof options.order, 'number')
  assert.equal(typeof options.label, 'function')
  assert.equal(options.label(), '内存回收')
  assert.equal(typeof registrations[0].component, 'function')
  assert.equal(dictionaries.length, 1)
  assert.equal(dictionaries[0][0], 'lowmem')
  assert.ok(dictionaries[0][1].zh['settings.title'])
  assert.ok(dictionaries[0][1].en['settings.title'])
})

test('纯函数：格式化、错误文本、配置换算', async () => {
  const source = await buildClient({ compact: false })
  const patched = source.replace(
    "    return {\n      inject: ['slots', 'locale'],",
    "    return {\n      checks: { TEXT, TEXT_EN, formatBytes, formatDuration, formatTime, errorText, configToForm, formToPayload, looksLikeConfig, extractConfig, reasonText },\n      inject: ['slots', 'locale'],",
  )
  assert.notEqual(patched, source, 'client.js 的返回对象形状变了，测试需要同步')
  const { loaded, harness } = await loadClient({ source: patched })
  const checks = loaded.factory(() => harness.react).checks
  assert.equal(checks.formatBytes(0), '0 B')
  assert.equal(checks.formatBytes(512), '512 B')
  assert.equal(checks.formatBytes(2048), '2.0 KB')
  assert.equal(checks.formatBytes(1610612736), '1.5 GB')
  assert.equal(checks.formatBytes(Number.NaN), '0 B')
  assert.equal(checks.formatDuration(19), '19 ms')
  assert.equal(checks.formatDuration(1500), '1.5 s')
  assert.equal(checks.formatDuration(0), '0 ms')
  assert.equal(checks.formatTime(0), '—')
  assert.equal(checks.errorText({ message: '失败', detail: '原因' }, '兜底'), '失败（原因）')
  assert.equal(checks.errorText(null, '兜底'), '兜底')
  assert.equal(checks.looksLikeConfig({ ok: true }), false)
  assert.equal(checks.looksLikeConfig(STATS_FIXTURE.config), true)
  // GET /config 两种形状都要认：直接返回 config，或包一层 { ok, config }
  assert.equal(checks.extractConfig(STATS_FIXTURE.config), STATS_FIXTURE.config)
  assert.equal(checks.extractConfig({ ok: true, config: STATS_FIXTURE.config }).thresholdBytes, 268435456)
  assert.equal(checks.extractConfig({ ok: true }), null)
  assert.equal(checks.reasonText('hard-cap', key => key), 'reason.hardCap')
  assert.equal(checks.reasonText('???', key => key), 'reason.unknown')
  const form = checks.configToForm(STATS_FIXTURE.config)
  assert.equal(form.enabled, true)
  assert.equal(form.thresholdMb, '256')
  assert.equal(form.hardCapMb, '3072')
  assert.equal(form.minIntervalSec, '60')
  assert.equal(form.idleIntervalSec, '300')
  const payload = checks.formToPayload(form, STATS_FIXTURE.config)
  assert.deepEqual(JSON.parse(JSON.stringify(payload)), {
    enabled: true,
    thresholdBytes: 268435456,
    minIntervalMs: 60000,
    idleIntervalMs: 300000,
    hardCapBytes: 3221225472,
  })
  // 填错时沿用旧值，不会把配置写成 NaN
  const broken = checks.formToPayload({ ...form, thresholdMb: '' }, STATS_FIXTURE.config)
  assert.equal(broken.thresholdBytes, 268435456)
  // 中英文词典键一致
  assert.deepEqual(Object.keys(checks.TEXT).sort(), Object.keys(checks.TEXT_EN).sort())
})

test('渲染冒烟：加载 → 正常 → 立即回收 → 保存配置', async () => {
  const routes = {
    '/api/dsh-lowmem/stats': STATS_FIXTURE,
    '/api/dsh-lowmem/config': { ok: true, config: STATS_FIXTURE.config },
    '/api/dsh-lowmem/trim': { ok: true, reclaimedBytes: 168000000, durationMs: 19 },
  }
  const { loaded, harness, calls, timers } = await loadClient({ routes })
  const module = loaded.factory(name => {
    if (name === 'react') return harness.react
    throw new Error('unexpected require')
  })
  const { ctx, registrations } = createCtx()
  module.apply(ctx)
  const component = registrations[0].component

  // 1. 首屏：加载中
  const loading = renderTree(harness, component, {})
  assert.match(textOf(loading), /正在读取内存状态/)

  // 2. 跑 effect：拉取 stats + config
  const cleanup = harness.effects[0]()
  await flush()
  const tree = renderTree(harness, component, {})
  const text = textOf(tree)
  assert.match(text, /malloc_trim/)
  assert.match(text, /1\.5 GB/)
  assert.match(text, /可用/)
  assert.match(text, /累计回收量/)
  assert.match(text, /触发阈值/)
  const numberInputs = findAll(tree, node => node.type === 'input' && node.props.type === 'number')
  assert.deepEqual(numberInputs.map(node => node.props.value), ['256', '3072', '60', '300'])
  assert.ok(timers.length === 1, '应该只起一个轮询定时器')
  assert.equal(timers[0].ms, 5000, '轮询间隔应该是 5 秒')

  // 3. 点「立即回收」
  const trimButton = findAll(tree, node => node.type === 'button' && textOf(node).includes('立即回收'))
  assert.equal(trimButton.length, 1)
  await trimButton[0].props.onClick()
  await flush()
  const trimCall = calls.find(call => call.method === 'POST' && call.url === '/api/dsh-lowmem/trim')
  assert.ok(trimCall, '没有发出回收请求')
  assert.equal(trimCall.body, JSON.stringify({ force: true }))

  // 4. 改阈值后保存，提交时换算回字节
  const after = renderTree(harness, component, {})
  const threshold = findAll(after, node => node.type === 'input' && node.props.value === '256')
  assert.equal(threshold.length, 1)
  threshold[0].props.onChange({ target: { value: '512' } })
  const edited = renderTree(harness, component, {})
  const saveButton = findAll(edited, node => node.type === 'button' && textOf(node).includes('保存'))
  assert.equal(saveButton.length, 1)
  await saveButton[0].props.onClick()
  await flush()
  const putCall = calls.find(call => call.method === 'PUT' && call.url === '/api/dsh-lowmem/config')
  assert.ok(putCall, '没有发出保存请求')
  const sent = JSON.parse(putCall.body)
  assert.equal(sent.enabled, true)
  assert.equal(sent.thresholdBytes, 536870912)
  assert.equal(sent.minIntervalMs, 60000)
  assert.equal(sent.hardCapBytes, 3221225472)

  // 5. 卸载时定时器要停掉
  cleanup()
  assert.equal(timers[0].cleared, true, '组件卸载后必须清掉轮询定时器')
})

test('接口连不上时显示可读提示，不抛异常', async () => {
  const { loaded, harness } = await loadClient({
    routes: {
      '/api/dsh-lowmem/stats': () => { throw new Error('boom') },
      '/api/dsh-lowmem/config': () => { throw new Error('boom') },
    },
  })
  const module = loaded.factory(() => harness.react)
  const { ctx, registrations } = createCtx()
  module.apply(ctx)
  const component = registrations[0].component
  renderTree(harness, component, {})
  harness.effects[0]()
  await flush()
  const tree = renderTree(harness, component, {})
  const text = textOf(tree)
  assert.match(text, /读取内存状态失败/)
  assert.match(text, /boom/)
  assert.match(text, /重试/)
})

test('回收失败时给出可读原因（取机制说明）', async () => {
  const routes = {
    '/api/dsh-lowmem/stats': STATS_FIXTURE,
    '/api/dsh-lowmem/config': { ok: true, config: STATS_FIXTURE.config },
    '/api/dsh-lowmem/trim': { ok: false, reclaimedBytes: 0, durationMs: 0, mechanism: { available: false, name: null, detail: '本平台暂不支持原生回收' } },
  }
  const { loaded, harness } = await loadClient({ routes })
  const module = loaded.factory(() => harness.react)
  const { ctx, registrations } = createCtx()
  module.apply(ctx)
  const component = registrations[0].component
  renderTree(harness, component, {})
  harness.effects[0]()
  await flush()
  const tree = renderTree(harness, component, {})
  const button = findAll(tree, node => node.type === 'button' && textOf(node).includes('立即回收'))
  await button[0].props.onClick()
  await flush()
  assert.match(textOf(renderTree(harness, component, {})), /本平台暂不支持原生回收/)
})

test('提交的 client.js 与 src/client/*.js 构建结果一致，且不越红线', async () => {
  const committed = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  assert.equal(committed, await buildClient(), 'client.js 未同步：运行 node scripts/build-client.mjs')
  assert.ok(committed.split('\n').length < 1000, '生成的 client.js 也要控制在 1000 行内')
  assert.doesNotThrow(() => new Script(committed), 'client.js 不是合法脚本')
  assert.ok(!/document\.body/.test(committed), '不能往 document.body 追加 DOM')
  assert.ok(!/document\.createElement/.test(committed), '不能在组件外写 DOM')
  assert.ok(!/@deepseek-ai/.test(committed), '不能 require @deepseek-ai/dsh-client-*')
  assert.ok(!/\biframe\b/.test(committed), '不能 iframe')
  const literals = [...committed.matchAll(/(?:color|background|border|boxShadow)\s*:\s*'([^']*)'/g)].map(match => match[1])
  for (const value of literals) {
    const allowed = value === 'transparent' || value.includes('transparent')
    assert.ok(allowed || value.includes('var(--dsw-alias-'), `样式写死了颜色：${value}`)
  }
})

test('locale 文件只含 meta', async () => {
  for (const name of ['en', 'zh']) {
    const raw = await readFile(new URL(`../locale/${name}.json`, import.meta.url), 'utf8')
    const parsed = JSON.parse(raw)
    assert.deepEqual(Object.keys(parsed), ['meta'])
    assert.deepEqual(Object.keys(parsed.meta).sort(), ['description', 'title'])
    assert.ok(parsed.meta.title.length > 0)
    assert.ok(parsed.meta.description.length > 0)
  }
})
