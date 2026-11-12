/**
 * 原生回收模块（src/host/trim）的单测。
 *
 * 原则：全部用假 koffi 注入，不碰真实系统库，保证在任何平台（Linux/macOS/Windows）
 * 上跑出来的结果都一样；真实 koffi 只留一个「装了才跑」的冒烟用例。
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { createTrimmer } from '../src/host/trim/index.mjs'

/**
 * 造一个假 koffi：记录所有「查符号」与「调用」动作。
 * @param {{missing?: string|null, loadError?: string|null, returns?: unknown}} [opts]
 *   - missing：含有该关键字的符号一查就抛错（模拟符号不存在）。
 *   - loadError：load() 直接抛错。
 *   - returns：所有原生调用的返回值（可以是函数，按定义分派）。
 * @returns {{calls: Array<object>, load: (name: string) => object}} 假 koffi。
 */
function createFakeKoffi(opts = {}) {
  const calls = []
  return {
    calls,
    load(name) {
      if (opts.loadError) throw new Error(opts.loadError)
      return {
        func(definition) {
          if (opts.missing && definition.includes(opts.missing)) {
            throw new Error(`Cannot find function '${opts.missing}' in shared library`)
          }
          calls.push({ kind: 'func', lib: name, definition })
          return (...args) => {
            calls.push({ kind: 'call', lib: name, definition, args })
            if (typeof opts.returns === 'function') return opts.returns(definition, args)
            return opts.returns ?? 0
          }
        },
      }
    },
  }
}

/**
 * 挑出某个符号的调用记录。
 * @param {object} fake - 假 koffi。
 * @param {string} definition - 符号定义串。
 * @returns {Array<object>} 调用记录。
 */
function findCalls(fake, definition) {
  return fake.calls.filter((call) => call.kind === 'call' && call.definition === definition)
}

/**
 * 在给定 RSS 序列下执行一段代码（临时替换 process.memoryUsage）。
 * @param {number[]} rssValues - 依次返回的 RSS 字节数。
 * @param {() => unknown} fn - 要执行的代码。
 * @returns {unknown} fn 的返回值。
 */
function withStubbedRss(rssValues, fn) {
  const original = process.memoryUsage
  let index = 0
  process.memoryUsage = () => {
    const rss = rssValues[Math.min(index, rssValues.length - 1)]
    index += 1
    return { rss, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }
  }
  try {
    return fn()
  } finally {
    process.memoryUsage = original
  }
}

test('linux：调用 malloc_trim 且参数为 0', async () => {
  const fake = createFakeKoffi()
  const trimmer = await createTrimmer({ platform: 'linux', loadKoffi: async () => fake })

  assert.equal(trimmer.available, true)
  assert.equal(trimmer.name, 'malloc_trim')
  assert.match(trimmer.detail, /malloc_trim/)

  const outcome = trimmer.trim()
  assert.equal(outcome.ok, true)

  const calls = findCalls(fake, 'int malloc_trim(size_t)')
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].args, [0])
})

test('darwin：调用 malloc_zone_pressure_relief', async () => {
  const fake = createFakeKoffi({ returns: 4096 })
  const trimmer = await createTrimmer({ platform: 'darwin', loadKoffi: async () => fake })

  assert.equal(trimmer.available, true)
  assert.equal(trimmer.name, 'malloc_zone_pressure_relief')

  const outcome = trimmer.trim()
  assert.equal(outcome.ok, true)

  const relief = findCalls(fake, 'size_t malloc_zone_pressure_relief(void*, size_t)')
  assert.equal(relief.length, 1)
  assert.equal(relief[0].args.length, 2)
  assert.equal(relief[0].args[1], 0)
  assert.equal(findCalls(fake, 'void* malloc_default_zone()').length, 1)
})

test('win32：调用 EmptyWorkingSet', async () => {
  const fake = createFakeKoffi({ returns: true })
  const trimmer = await createTrimmer({ platform: 'win32', loadKoffi: async () => fake })

  assert.equal(trimmer.available, true)
  assert.equal(trimmer.name, 'EmptyWorkingSet')

  const outcome = trimmer.trim()
  assert.equal(outcome.ok, true)

  assert.equal(findCalls(fake, 'bool EmptyWorkingSet(void*)').length, 1)
  assert.equal(findCalls(fake, 'void* GetCurrentProcess()').length, 1)
})

test('未知平台：available=false、name=null', async () => {
  const trimmer = await createTrimmer({
    platform: 'sunos',
    // 未知平台根本不该去加载 koffi，这里让它一旦被调用就炸。
    loadKoffi: async () => {
      throw new Error('未知平台不应该加载 koffi')
    },
  })

  assert.equal(trimmer.available, false)
  assert.equal(trimmer.name, null)
  assert.match(trimmer.detail, /本平台暂不支持原生回收/)

  const outcome = trimmer.trim()
  assert.equal(outcome.ok, false)
  assert.equal(outcome.reclaimedBytes, 0)
  assert.ok(outcome.durationMs >= 0)
})

test('koffi 加载失败：available=false 且 detail 含原因', async () => {
  const trimmer = await createTrimmer({
    platform: 'linux',
    loadKoffi: async () => {
      throw new Error('Cannot find module \'koffi\'')
    },
  })

  assert.equal(trimmer.available, false)
  assert.equal(trimmer.name, null)
  assert.match(trimmer.detail, /koffi 加载失败/)
  assert.match(trimmer.detail, /koffi/)
})

test('符号不存在：available=false 且不抛异常', async () => {
  const fake = createFakeKoffi({ missing: 'malloc_trim' })
  const trimmer = await createTrimmer({ platform: 'linux', loadKoffi: async () => fake })

  assert.equal(trimmer.available, false)
  assert.equal(trimmer.name, null)
  assert.match(trimmer.detail, /malloc_trim/)

  const outcome = trimmer.trim()
  assert.equal(outcome.ok, false)
  assert.equal(outcome.reclaimedBytes, 0)
})

test('musl：detail 能区分出 musl', async () => {
  const fake = createFakeKoffi({ missing: 'malloc_trim' })
  const originalGetReport = process.report.getReport
  try {
    // 模拟 musl：Node 的 process.report 里没有 glibcVersionRuntime。
    process.report.getReport = () => ({ header: { arch: 'x64' } })
    const trimmer = await createTrimmer({ platform: 'linux', loadKoffi: async () => fake })

    assert.equal(trimmer.available, false)
    assert.equal(trimmer.name, null)
    assert.match(trimmer.detail, /musl/)
  } finally {
    process.report.getReport = originalGetReport
  }
})

test('原生调用抛异常：trim() 返回 ok=false 且不抛出', async () => {
  const fake = createFakeKoffi()
  fake.load = () => ({
    func: () => () => {
      throw new Error('native boom')
    },
  })
  const trimmer = await createTrimmer({ platform: 'linux', loadKoffi: async () => fake })

  assert.equal(trimmer.available, true)

  const outcome = trimmer.trim()
  assert.equal(outcome.ok, false)
  assert.match(outcome.error, /native boom/)
  assert.equal(outcome.reclaimedBytes, 0)
  assert.ok(outcome.durationMs >= 0)
})

test('回收量取调用前后的 RSS 差值', async () => {
  const fake = createFakeKoffi()
  const trimmer = await createTrimmer({ platform: 'linux', loadKoffi: async () => fake })

  const outcome = withStubbedRss([1000000, 400000], () => trimmer.trim())
  assert.equal(outcome.ok, true)
  assert.equal(outcome.reclaimedBytes, 600000)
})

test('RSS 差值为 0 时用 macOS 原生返回的字节数', async () => {
  const fake = createFakeKoffi({ returns: 4096 })
  const trimmer = await createTrimmer({ platform: 'darwin', loadKoffi: async () => fake })

  const outcome = withStubbedRss([5000000, 5000000], () => trimmer.trim())
  assert.equal(outcome.ok, true)
  assert.equal(outcome.reclaimedBytes, 4096)
})

test('glibc 的返回标志位不算字节数', async () => {
  // 真实 glibc 的 malloc_trim 返回 1 表示「确实释放了」，它是标志位不是字节数。
  const fake = createFakeKoffi({ returns: 1 })
  const trimmer = await createTrimmer({ platform: 'linux', loadKoffi: async () => fake })

  const outcome = withStubbedRss([5000000, 5000000], () => trimmer.trim())
  assert.equal(outcome.ok, true)
  assert.equal(outcome.reclaimedBytes, 0)
})

test('RSS 涨了也不报负数', async () => {
  const fake = createFakeKoffi()
  const trimmer = await createTrimmer({ platform: 'linux', loadKoffi: async () => fake })

  const outcome = withStubbedRss([1000, 9000], () => trimmer.trim())
  assert.equal(outcome.reclaimedBytes, 0)
})

test('trim() 返回值：reclaimedBytes >= 0、durationMs >= 0', async () => {
  const trimmer = await createTrimmer({ platform: 'linux', loadKoffi: async () => createFakeKoffi() })
  const outcome = trimmer.trim()

  assert.equal(typeof outcome.ok, 'boolean')
  assert.equal(typeof outcome.reclaimedBytes, 'number')
  assert.equal(typeof outcome.durationMs, 'number')
  assert.ok(outcome.reclaimedBytes >= 0)
  assert.ok(outcome.durationMs >= 0)
})

test('调用方可以传入已采样的 rssBytes 作为基线', async () => {
  const fake = createFakeKoffi()
  const trimmer = await createTrimmer({ platform: 'linux', loadKoffi: async () => fake })

  const outcome = withStubbedRss([800000], () => trimmer.trim({ rssBytes: 1000000 }))
  assert.equal(outcome.reclaimedBytes, 200000)
})

test('koffi 是懒加载的：模块顶层没有静态 import', async () => {
  const source = await readFile(fileURLToPath(new URL('../src/host/trim/index.mjs', import.meta.url)), 'utf8')

  assert.doesNotMatch(source, /^\s*import\s[^\n]*from\s*['"]koffi['"]/m)
  assert.match(source, /await import\('koffi'\)/)
})

test('真实 koffi（若已安装）：linux 路径可用', async (t) => {
  let koffi
  try {
    koffi = await import('koffi')
  } catch {
    t.skip('koffi 未安装，跳过真实路径')
    return
  }

  const trimmer = await createTrimmer({ platform: 'linux', loadKoffi: async () => koffi })
  if (!trimmer.available) {
    t.skip(`本机没有 malloc_trim：${trimmer.detail}`)
    return
  }

  assert.equal(trimmer.name, 'malloc_trim')
  const outcome = trimmer.trim()
  assert.equal(outcome.ok, true)
  assert.ok(outcome.reclaimedBytes >= 0)
  assert.ok(outcome.durationMs >= 0)
})
