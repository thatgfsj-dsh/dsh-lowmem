/**
 * 截图脚本共用的 CDP（Chrome DevTools Protocol）小工具。
 *
 * 只依赖 Node 内置的全局 `WebSocket`（Node 22+ 自带），不引入 puppeteer 之类重依赖。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 默认窗口尺寸：1440×900，足够放下侧栏 + 主区 + 设置面板。 */
export const VIEWPORT = { width: 1440, height: 900 }

/** 找出本机的 Chrome/Chromium。 */
export function findChrome() {
  if (process.env.CHROME !== undefined && process.env.CHROME !== '') return process.env.CHROME
  const candidates = [
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium',
    '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge', '/opt/microsoft/msedge/msedge',
  ]
  return candidates.find(path => existsSync(path))
}

/** 等待某个条件成立。 */
export async function waitFor(label, probe, timeoutMs = 90000, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== undefined && value !== null && value !== false) return value
    if (Date.now() >= deadline) throw new Error(`等待超时：${label}`)
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
}

/** 短暂等待。 */
export const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

/** 连上 CDP。 */
export async function connectCdp(browserWs) {
  const socket = new WebSocket(browserWs)
  await new Promise((resolveOpen, reject) => {
    socket.onopen = resolveOpen
    socket.onerror = () => reject(new Error('CDP WebSocket 连接失败'))
  })
  let nextId = 0
  const pending = new Map()
  socket.onmessage = event => {
    const message = JSON.parse(event.data)
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message)
      pending.delete(message.id)
    }
  }
  const send = (method, params = {}) => new Promise(resolveSend => {
    const id = ++nextId
    pending.set(id, resolveSend)
    socket.send(JSON.stringify({ id, method, params }))
  })
  return { send, close: () => socket.close() }
}

/** 在页面里求值并取回结果。 */
export async function evaluate(cdp, expression) {
  const response = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (response.result?.exceptionDetails !== undefined) {
    throw new Error(`页面求值失败：${response.result.exceptionDetails.text ?? '未知错误'}`)
  }
  return response.result?.result?.value
}

/**
 * 启动 headless Chrome 并连上页面。
 * @param {string} url - 打开的地址。
 * @param {object} [options] - 选项。
 * @param {string} [options.userDataDir] - 用户数据目录（不传则建临时目录）。
 * @returns {Promise<{page: object, browser: object, chrome: object, cleanup: () => Promise<void>}>} 连接句柄。
 */
export async function openChrome(url, options = {}) {
  const binary = findChrome()
  if (binary === undefined) throw new Error('本机没有 Chrome')
  const userDataDir = options.userDataDir ?? await mkdtemp(join(tmpdir(), 'dsh-chrome-'))
  const chrome = spawn(binary, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${userDataDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`, url,
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  chrome.stderr.on('data', chunk => { stderr += String(chunk) })
  const browserWs = await waitFor('Chrome DevTools', () => stderr.match(/DevTools listening on (ws:\/\/\S+)/)?.[1], 30000)
  const browser = await connectCdp(browserWs)
  const origin = new URL(url).origin
  const target = await waitFor('页面 target', async () => {
    const response = await fetch(`${browserWs.replace('ws://', 'http://').replace(/\/devtools\/browser\/.*$/, '')}/json/list`)
    const list = await response.json()
    return list.find(item => item.type === 'page' && item.url.startsWith(origin))
  }, 30000)
  const page = await connectCdp(target.webSocketDebuggerUrl)
  await page.send('Runtime.enable')
  await page.send('Emulation.setDeviceMetricsOverride', { width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false })
  await waitFor('页面加载完成', () => evaluate(page, 'document.readyState === "complete"'), 30000)
  await sleep(1800)
  return {
    page,
    browser,
    chrome,
    cleanup: async () => {
      try { chrome.kill('SIGKILL') } catch { /* 已退出 */ }
    },
  }
}

/**
 * 关掉挡住界面的引导/登录层（临时实例没有凭据，会弹「开始使用」）。
 * @param {object} page - CDP 页面连接。
 * @returns {Promise<boolean>} 是否点掉了某个遮罩。
 */
export async function dismissOverlays(page) {
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(700)
  const dismissed = await evaluate(page, `(() => {
    const candidates = [...document.querySelectorAll('[role="dialog"], [class*="_dialog"]')]
    for (const node of candidates) {
      if (!(node.textContent ?? '').includes('开始使用')) continue
      const close = [...node.querySelectorAll('button')]
        .find(button => (button.getAttribute('aria-label') ?? '').includes('关闭'))
      if (close !== undefined) { close.click(); return true }
    }
    return false
  })()`)
  await sleep(600)
  return dismissed === true
}

/**
 * 截一张图。
 * @param {object} page - CDP 页面连接。
 * @param {string} file - 输出文件绝对路径。
 * @returns {Promise<Buffer>} 图片字节。
 */
export async function capturePng(page, file) {
  const shot = await page.send('Page.captureScreenshot', { format: 'png' })
  if (shot.result?.data === undefined) throw new Error(`截图失败：${file}`)
  return Buffer.from(shot.result.data, 'base64')
}
