/**
 * 宿主事件挂载的结构单测：观察者与中间件的语义不能混用。
 *
 * `tools/result` 是 emit，返回值被忽略；`tools/pre-execute` 是 waterfall，
 * 监听器必须调用 next()，否则会否决整条链——宿主拿到的 gate 是 undefined，
 * 随后 `gate.kind` 抛 `Cannot read properties of undefined (reading 'kind')`，
 * 表现为所有工具调用一起失败。本文件锁住这一条契约。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../index.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 宿主事件的分派模式（emit = 观察者，返回值被忽略；waterfall = 中间件，必须 next()）。
 * 这份表是**白名单**：订阅表外的事件必须先把它分类并加进来，否则「每个订阅到的事件
 * 都已被分级」这条测试会失败。有了它，新增订阅时就不会再静默踩到 waterfall。
 */
const KNOWN_EVENT_MODES = {
  'tools/result': 'emit',
  'tools/pre-execute': 'waterfall',
}

/** 收集 `ctx.on` 注册的监听器，其它宿主服务一律给最小替身。 */
function createFakeHost() {
  const listeners = new Map()
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    // apply 只在 connection 就绪后才注册路由与采样循环；单测不跑那条分支。
    inject() {},
    on(event, handler, options) {
      listeners.set(event, { handler, options })
      return () => listeners.delete(event)
    },
    effect() {},
    get() { return undefined },
  }
  return { ctx, listeners }
}

test('预执行监听器把决策继续传给下游', () => {
  const { ctx, listeners } = createFakeHost()
  apply(ctx, { enabled: true })

  const middleware = listeners.get('tools/pre-execute')
  assert.ok(middleware, '必须注册 tools/pre-execute 监听器')

  const decision = { kind: 'allow' }
  let calls = 0
  const returned = middleware.handler({ name: 'run_code' }, () => {
    calls += 1
    return decision
  })

  assert.equal(calls, 1, '必须调用一次 next()')
  assert.equal(returned, decision, '必须把下游的决策原样返回')
})

test('结果观察器保持 emit 语义', () => {
  const { ctx, listeners } = createFakeHost()
  apply(ctx, { enabled: true })

  const observer = listeners.get('tools/result')
  assert.ok(observer, '必须注册 tools/result 观察器')
  assert.equal(observer.handler({ name: 'run_code' }, { isError: false }), undefined)
})

test('每个订阅到的事件都已被分级', async () => {
  const source = await readFile(join(ROOT, 'index.js'), 'utf8')
  const subscribed = [...source.matchAll(/ctx\.on\(\s*'([^']+)'/g)].map((match) => match[1])
  assert.ok(subscribed.length > 0, 'index.js 里应当至少有一个 ctx.on 订阅')

  const unclassified = subscribed.filter((event) => KNOWN_EVENT_MODES[event] === undefined)
  assert.deepEqual(unclassified, [], '订阅了未分级的事件：' + unclassified.join(', ')
    + '（先确认它是 emit 还是 waterfall，再补进 KNOWN_EVENT_MODES）')
})

test('中间件类事件的监听器都调用了 next()', async () => {
  const source = await readFile(join(ROOT, 'index.js'), 'utf8')
  // 粗粒度但有效的静态检查：waterfall 事件的订阅行附近必须出现 next(。
  for (const [event, mode] of Object.entries(KNOWN_EVENT_MODES)) {
    if (mode !== 'waterfall') continue
    const at = source.indexOf("ctx.on('" + event + "'")
    if (at === -1) continue
    const window = source.slice(at, at + 400)
    assert.ok(/\bnext\(/.test(window), event + ' 是 waterfall，监听器必须调用 next()')
  }
})
