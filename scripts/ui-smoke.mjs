/**
 * 浏览器 UI 冒烟：验证设置页里真的能看到「内存回收」分区，并能手动触发一次回收。
 *
 * 用临时 DSH 实例（真实 web profile 的副本 + 随机端口）与 headless Chrome，
 * 不触碰线上 dsh web 与真实会话。
 *
 * 步骤：
 * 1. 起临时实例；
 * 2. 用启动令牌打开页面；
 * 3. 账号菜单 → 设置 → 「内存回收」分区；
 * 4. 断言分区渲染出 RSS / 机制 / 统计 / 「立即回收」；
 * 5. 点「立即回收」，断言统计刷新；
 * 6. 截图存档。
 *
 * 用法：node scripts/ui-smoke.mjs
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { capturePng, dismissOverlays, evaluate, openChrome, sleep, waitFor } from './lib/cdp.mjs'
import { startTempInstance } from './lib/instance.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOT_DIR = join(ROOT, 'docs', 'screenshots')
const SHOT = join(SHOT_DIR, '01-lowmem-settings.png')

const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : '：' + detail}`)
  if (!ok) failures.push(name + (detail === '' ? '' : '（' + detail + '）'))
}

let instance = null
let chrome = null
try {
  await mkdir(SHOT_DIR, { recursive: true })
  console.log('起临时实例…')
  instance = await startTempInstance(ROOT)
  console.log('临时实例：' + instance.base)

  chrome = await openChrome(instance.url)
  await dismissOverlays(chrome.page)
  await sleep(1200)

  console.log('打开设置页…')
  await evaluate(chrome.page, `(() => {
    const button = document.querySelector('button[aria-label="账号菜单"]')
    if (button === undefined) return false
    button.click()
    return true
  })()`)
  await sleep(900)
  await evaluate(chrome.page, `(() => {
    const item = [...document.querySelectorAll('[role=menuitem]')].find(node => (node.textContent ?? '').trim() === '设置')
    if (item === undefined) return false
    item.click()
    return true
  })()`)
  await sleep(1800)

  const opened = await evaluate(chrome.page, `(() => {
    const button = [...document.querySelectorAll('button')].find(node => (node.textContent ?? '').trim() === '内存回收')
    if (button === undefined) return false
    button.click()
    return true
  })()`)
  check('设置页里能找到「内存回收」分区', opened === true)
  await sleep(1800)

  const text = String(await evaluate(chrome.page, 'document.body.innerText'))
  check('分区显示当前内存占用', /RSS/.test(text), text.slice(0, 0))
  check('分区显示原生机制', /malloc_trim|malloc_zone_pressure_relief|EmptyWorkingSet|暂不支持/.test(text))
  check('分区显示累计统计', /累计|次数|回收/.test(text))
  check('分区有「立即回收」按钮', text.includes('立即回收'))

  const before = await instance.call('/api/dsh-lowmem/stats')
  const clicked = await evaluate(chrome.page, `(() => {
    const button = [...document.querySelectorAll('button')].find(node => (node.textContent ?? '').trim() === '立即回收')
    if (button === undefined) return false
    button.click()
    return true
  })()`)
  check('点得到「立即回收」', clicked === true)
  await sleep(2500)
  const after = await instance.call('/api/dsh-lowmem/stats')
  check('点击后宿主确实回收了一次', after.body.trim.count > before.body.trim.count,
    'count ' + before.body.trim.count + ' → ' + after.body.trim.count)

  // capturePng 只回传 Buffer，落盘是自己的事。
  const png = await capturePng(chrome.page, SHOT)
  await writeFile(SHOT, png)
  console.log('截图：' + SHOT + '（' + Math.round(png.length / 1024) + ' KB）')
} catch (error) {
  check('UI 冒烟没有异常', false, error instanceof Error ? error.message : String(error))
} finally {
  if (chrome !== null) await chrome.cleanup().catch(() => {})
  if (instance !== null) await instance.stop().catch(() => {})
}

console.log('')
if (failures.length > 0) {
  console.log('UI 冒烟失败 ' + failures.length + ' 项：')
  for (const f of failures) console.log('  - ' + f)
  process.exitCode = 1
} else {
  console.log('UI 冒烟全部通过')
}
