/**
 * Windows 路径的**实机**验证用例（通过 Wine + Windows Node）。
 *
 * 为什么要单独一个文件：Windows 平台在普通 CI 上根本没法测，
 * "EmptyWorkingSet 到底在哪个库里导出""GetCurrentProcess 能不能这么调"
 * 这种问题不实测就只能靠猜。这里把猜测变成可复现的断言。
 *
 * 已实测的事实（Wine 10.0 + Windows Node 24 + koffi）：
 * - `koffi.load('psapi.dll')` 与 `koffi.load('kernel32.dll')` 都能加载；
 * - `EmptyWorkingSet` **只在 psapi.dll 导出**，kernel32.dll 里没有
 *   （`Cannot find function 'EmptyWorkingSet' in shared library`）；
 * - `EmptyWorkingSet(GetCurrentProcess())` 返回 true，耗时 0 ms。
 *
 * **不断言 RSS 会下降**：Wine 的内存计量与真实 Windows 不同
 * （`process.memoryUsage().rss` 不等于 Windows 工作集），断言它必然 flaky。
 *
 * 本机没有 Wine 时**优雅跳过**（SKIP，退出码 0），不会把 CI 拖红。
 * 这个文件名不匹配 node --test 的默认 glob，所以不会混进主测试套件；
 * 想跑它：node --test tests/wine-win32-smoke.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { checkWineResults, probeWine } from '../scripts/wine-win32-smoke.mjs'

/** 探测只跑一次，多个用例共用结果。 */
let probePromise = null

/**
 * 拿探测结果（只跑一次）。
 * @returns {Promise<object>} 探测结果。
 */
function getProbe() {
  if (probePromise === null) probePromise = probeWine()
  return probePromise
}

test('Wine 实机：psapi.dll 与 kernel32.dll 都能加载', async (t) => {
  const probe = await getProbe()
  if (probe.skipped) {
    t.skip(probe.reason)
    return
  }
  assert.ok(probe.results !== null, probe.reason ?? '探测失败')
  assert.equal(probe.results.psapiLoaded, true, "koffi.load('psapi.dll') 应当成功")
  assert.equal(probe.results.kernel32Loaded, true, "koffi.load('kernel32.dll') 应当成功")
})

test('Wine 实机：EmptyWorkingSet 只在 psapi.dll 导出', async (t) => {
  const probe = await getProbe()
  if (probe.skipped) {
    t.skip(probe.reason)
    return
  }
  assert.ok(probe.results !== null, probe.reason ?? '探测失败')
  assert.equal(
    probe.results.psapiHasEmptyWorkingSet,
    true,
    'psapi.dll 必须导出 EmptyWorkingSet：' + String(probe.results.psapiSymbolError),
  )
  assert.equal(
    probe.results.kernel32HasEmptyWorkingSet,
    false,
    'kernel32.dll 里没有 EmptyWorkingSet，策略必须从 psapi.dll 取符号：'
      + String(probe.results.kernel32SymbolError),
  )
})

test('Wine 实机：EmptyWorkingSet(GetCurrentProcess()) 返回 true，耗时 0 ms', async (t) => {
  const probe = await getProbe()
  if (probe.skipped) {
    t.skip(probe.reason)
    return
  }
  assert.ok(probe.results !== null, probe.reason ?? '探测失败')
  assert.equal(probe.results.emptyWorkingSetRc, true, 'EmptyWorkingSet 应当返回 true')
  assert.equal(typeof probe.results.durationMs, 'number')
  assert.ok(probe.results.durationMs >= 0 && probe.results.durationMs <= 1000, '耗时应当在毫秒级')
})

test('Wine 实机：不断言 RSS 会下降', async (t) => {
  const probe = await getProbe()
  if (probe.skipped) {
    t.skip(probe.reason)
    return
  }
  // Wine 的内存计量与真实 Windows 不同，RSS 不是可靠指标——
  // 检查清单里不允许出现任何跟 RSS 下降有关的断言。
  const { checks } = checkWineResults(probe.results)
  const rssChecks = checks.filter((check) => /rss|内存下降|下降/i.test(check.label))
  assert.deepEqual(rssChecks, [], '不得断言 Wine 下的 RSS 会下降')
})
