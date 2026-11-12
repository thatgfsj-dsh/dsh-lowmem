/**
 * Windows 路径的实机验证（通过 Wine）。
 *
 * 为什么要专门写这个：Windows 平台**没有任何人能在普通 CI 上真机测**，
 * 于是"psapi.dll 里到底有没有 EmptyWorkingSet""GetCurrentProcess 能不能这么调"
 * 这类问题就只能靠猜。本脚本用 Wine 下的 Windows Node 把它变成可验证的。
 *
 * 已实测（本机 Wine 10.0 + Windows Node 24 + koffi）：
 * - `koffi.load('psapi.dll')` 与 `koffi.load('kernel32.dll')` 都能加载；
 * - `EmptyWorkingSet` **只有 psapi.dll 导出**，kernel32.dll 里找不到
 *   （`Cannot find function 'EmptyWorkingSet' in shared library`）——
 *   所以策略必须从 psapi.dll 取符号，不能想当然地从 kernel32 取；
 * - `EmptyWorkingSet(GetCurrentProcess())` 返回 `true`，耗时 0 ms。
 *
 * 注意：Wine 的内存计量与真实 Windows 不同（`process.memoryUsage().rss` 不等于
 * Windows 工作集），所以这里**不断言 RSS 会下降**，只断言调用链正确、返回成功。
 *
 * ## 两个踩过的坑（别改回去）
 *
 * 1. **路径要用 Wine 的 Z: 映射**。Wine 默认把 Linux 的 `/` 映射成 `Z:\`，
 *    所以 Linux 的 `/tmp/x.cjs` 在 Windows 侧是 `Z:\\tmp\\x.cjs`。
 *    之前用 `C:\\tmp` 直接失败。
 * 2. **stdout/stderr 必须落到文件，不能用管道**。Wine 下的 Windows node
 *    在 stdio 是管道时会以 `Error: open EBADF` 崩在启动阶段（node:net:651）。
 *    所以这里用 openSync() 把子进程的两个 fd 直接指到临时文件。
 *
 * 用法：node scripts/wine-win32-smoke.mjs
 * 环境变量：
 * - `WINE_NODE`   Windows node.exe 路径
 * - `WINE_PREFIX` WINEPREFIX 路径
 * - `KOFFI_WIN`   Wine 下 win32 koffi 的 node_modules 根目录
 */
import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Wine 下的 Windows node.exe。 */
export const WINE_NODE = process.env.WINE_NODE ?? '/home/thatgfsj/.wine/drive_c/node24/node.exe'
/** WINEPREFIX。 */
export const WINE_PREFIX = process.env.WINE_PREFIX ?? '/home/thatgfsj/.wine'
/** Wine 下的 win32 koffi（node_modules 根目录）。 */
export const KOFFI_WIN = process.env.KOFFI_WIN
  ?? '/home/thatgfsj/.wine/drive_c/Program Files/WorkBuddy/resources/app.asar.unpacked/node_modules/koffi'

/**
 * 把 Linux 路径转成 Wine 的 Windows 路径（默认 Z: 映射的是 `/`）。
 * @param {string} linuxPath - Linux 路径。
 * @returns {string} Windows 路径。
 */
export function toWinePath(linuxPath) {
  return 'Z:' + String(linuxPath).replace(/\//g, '\\')
}

/**
 * Windows 侧跑的探测脚本（CommonJS）。
 * 它只做一件事：把探测结果以一行 JSON 打出来，Linux 侧再断言。
 */
const PROBE_SOURCE = [
  "const koffiPath = process.argv[2]",
  "const out = {",
  "  koffiRequired: false, requireError: null,",
  "  psapiLoaded: false, psapiError: null,",
  "  kernel32Loaded: false, kernel32Error: null,",
  "  psapiHasEmptyWorkingSet: false, psapiSymbolError: null,",
  "  kernel32HasEmptyWorkingSet: false, kernel32SymbolError: null,",
  "  getCurrentProcessOk: false, getCurrentProcessError: null,",
  "  emptyWorkingSetRc: null, durationMs: null,",
  "  rssBefore: null, rssAfter: null,",
  "}",
  "let koffi = null",
  "try {",
  "  koffi = require(koffiPath)",
  "  out.koffiRequired = true",
  "} catch (error) {",
  "  out.requireError = String(error && error.message ? error.message : error)",
  "  console.log('PROBE_RESULT=' + JSON.stringify(out))",
  "  process.exit(0)",
  "}",
  "try { koffi.load('psapi.dll'); out.psapiLoaded = true } catch (error) { out.psapiError = String(error.message) }",
  "try { koffi.load('kernel32.dll'); out.kernel32Loaded = true } catch (error) { out.kernel32Error = String(error.message) }",
  "let ews = null",
  "try { ews = koffi.load('psapi.dll').func('bool EmptyWorkingSet(void*)'); out.psapiHasEmptyWorkingSet = true }",
  "catch (error) { out.psapiSymbolError = String(error.message) }",
  "try { koffi.load('kernel32.dll').func('bool EmptyWorkingSet(void*)'); out.kernel32HasEmptyWorkingSet = true }",
  "catch (error) { out.kernel32SymbolError = String(error.message) }",
  "let gcp = null",
  "try { gcp = koffi.load('kernel32.dll').func('void* GetCurrentProcess()'); out.getCurrentProcessOk = true }",
  "catch (error) { out.getCurrentProcessError = String(error.message) }",
  "if (ews && gcp) {",
  "  out.rssBefore = process.memoryUsage().rss",
  "  const t0 = Date.now()",
  "  try { out.emptyWorkingSetRc = ews(gcp()) } catch (error) { out.emptyWorkingSetRc = 'throw: ' + String(error.message) }",
  "  out.durationMs = Date.now() - t0",
  "  out.rssAfter = process.memoryUsage().rss",
  "}",
  "console.log('PROBE_RESULT=' + JSON.stringify(out))",
  "process.exit(0)",
].join('\n')

/**
 * 跑一次 Wine 探测。
 * @param {{wineNode?: string, winePrefix?: string, koffiWin?: string, timeoutMs?: number}} [options] - 覆盖项。
 * @returns {Promise<{skipped: boolean, reason?: string, results?: object, stdout?: string, stderr?: string, exitCode?: number}>}
 *   探测结果。
 */
export async function probeWine(options = {}) {
  const wineNode = options.wineNode ?? WINE_NODE
  const winePrefix = options.winePrefix ?? WINE_PREFIX
  const koffiWin = options.koffiWin ?? KOFFI_WIN
  const timeoutMs = options.timeoutMs ?? 120_000

  if (!existsSync(wineNode)) {
    return { skipped: true, reason: `本机没有 Windows node.exe（${wineNode}）` }
  }
  if (!existsSync(koffiWin)) {
    return { skipped: true, reason: `找不到 Wine 下的 win32 koffi（${koffiWin}）` }
  }

  const dir = mkdtempSync(join(tmpdir(), 'dsh-lowmem-wine-'))
  const script = join(dir, 'probe.cjs')
  const stdoutFile = join(dir, 'stdout.txt')
  const stderrFile = join(dir, 'stderr.txt')
  writeFileSync(script, PROBE_SOURCE, 'utf8')

  const stdoutFd = openSync(stdoutFile, 'w')
  const stderrFd = openSync(stderrFile, 'w')
  let child
  try {
    child = spawn('wine', [wineNode, toWinePath(script), toWinePath(koffiWin)], {
      env: { ...process.env, WINEPREFIX: winePrefix },
      // 必须是文件而不是管道：Wine 下的 Windows node 在管道 stdio 下会以 EBADF 崩掉。
      stdio: ['ignore', stdoutFd, stderrFd],
    })
  } catch (error) {
    closeSync(stdoutFd)
    closeSync(stderrFd)
    rmSync(dir, { recursive: true, force: true })
    return { skipped: true, reason: `起不来 wine：${error instanceof Error ? error.message : String(error)}` }
  }

  const exitCode = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
    }, timeoutMs)
    child.on('error', () => {
      clearTimeout(timer)
      resolve(-1)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })

  closeSync(stdoutFd)
  closeSync(stderrFd)

  const stdout = readFileSync(stdoutFile, 'utf8')
  const stderr = readFileSync(stderrFile, 'utf8')
  rmSync(dir, { recursive: true, force: true })

  const match = /PROBE_RESULT=(\{.*\})/.exec(stdout)
  if (match === null) {
    return {
      skipped: false,
      results: null,
      stdout,
      stderr,
      exitCode,
      reason: '探测脚本没有输出 PROBE_RESULT',
    }
  }
  let results = null
  try {
    results = JSON.parse(match[1])
  } catch (error) {
    return {
      skipped: false,
      results: null,
      stdout,
      stderr,
      exitCode,
      reason: `探测结果不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    }
  }
  return { skipped: false, results, stdout, stderr, exitCode }
}

/**
 * 把探测结果变成"断言清单"。
 *
 * 刻意**不包含**"RSS 会下降"这一条：Wine 的内存计量与真实 Windows 不同，
 * `process.memoryUsage().rss` 不等于 Windows 工作集，断言它必然 flaky。
 * @param {object} results - 探测结果。
 * @returns {{checks: Array<{ok: boolean, label: string, detail: string}>}} 检查清单。
 */
export function checkWineResults(results) {
  const checks = []
  /**
   * @param {boolean} ok - 是否通过。
   * @param {string} label - 检查项。
   * @param {string} detail - 细节。
   * @returns {void}
   */
  const add = (ok, label, detail) => checks.push({ ok, label, detail })

  add(results.koffiRequired === true, 'win32 koffi 能被 require', String(results.requireError))
  add(results.psapiLoaded === true, "koffi.load('psapi.dll') 能加载", String(results.psapiError))
  add(results.kernel32Loaded === true, "koffi.load('kernel32.dll') 能加载", String(results.kernel32Error))
  add(
    results.psapiHasEmptyWorkingSet === true,
    'EmptyWorkingSet 在 psapi.dll 里导出',
    String(results.psapiSymbolError),
  )
  add(
    results.kernel32HasEmptyWorkingSet === false,
    'EmptyWorkingSet 不在 kernel32.dll 里导出（策略必须走 psapi.dll）',
    String(results.kernel32SymbolError),
  )
  add(results.getCurrentProcessOk === true, 'GetCurrentProcess 能从 kernel32.dll 取到', String(results.getCurrentProcessError))
  add(results.emptyWorkingSetRc === true, 'EmptyWorkingSet(GetCurrentProcess()) 返回 true', String(results.emptyWorkingSetRc))
  add(
    typeof results.durationMs === 'number' && results.durationMs >= 0 && results.durationMs <= 1000,
    '调用耗时在毫秒级（实测 0 ms）',
    String(results.durationMs),
  )
  return { checks }
}

/**
 * 脚本入口：打印 PASS / FAIL，失败时退出码 1。
 * @returns {Promise<number>} 退出码。
 */
export async function main() {
  const probe = await probeWine()
  if (probe.skipped) {
    console.log('SKIP  ' + probe.reason + '，跳过 Windows 路径验证')
    return 0
  }
  if (probe.results === null) {
    console.log('FAIL  ' + (probe.reason ?? '探测失败'))
    console.log('      stdout: ' + String(probe.stdout).slice(-400))
    console.log('      stderr: ' + String(probe.stderr).slice(-400))
    return 1
  }

  const { checks } = checkWineResults(probe.results)
  let failed = 0
  for (const check of checks) {
    if (check.ok) {
      console.log('PASS  ' + check.label + (check.detail ? '（' + check.detail + '）' : ''))
    } else {
      failed++
      console.log('FAIL  ' + check.label + (check.detail ? '（' + check.detail + '）' : ''))
    }
  }
  // 只作为信息打印：Wine 的内存计量与真实 Windows 不同，这里不做任何断言。
  console.log('INFO  RSS before=' + probe.results.rssBefore + ' after=' + probe.results.rssAfter
    + '（Wine 下不断言 RSS 会下降）')
  if (failed > 0) {
    console.log('Windows 路径验证失败：' + failed + ' 项')
    return 1
  }
  console.log('Windows 路径验证通过')
  return 0
}

/** 直接执行本文件时跑 main()。 */
const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  process.exitCode = await main()
}
