/**
 * 自检：在**临时 DSH 实例**里验证本插件真的能把内存还给操作系统。
 *
 * 不触碰正在运行的 dsh web 与真实会话：临时 DSH_HOME + 真实 web profile 的副本 + 随机端口。
 *
 * 步骤：
 * 1. 复制本机的 web profile 到临时 DSH_HOME（沿用本机其它插件的既有做法：
 *    真实 profile 的副本比最小 profile 可靠——最小 profile 缺宿主接线，/api 路由整体 404）；
 * 2. dsh plugin --profile web add <本仓库>；
 * 3. 用 --dump-config 复核配置层：我们的行在、旋钮覆盖生效、没有 "entry not found"；
 * 4. 起临时实例（--port 0），从启动输出里取端口与启动令牌；
 * 5. 用令牌换到会话 cookie（宿主把 /api 放在浏览器信任栅栏后面，
 *    GET /?token=... 会 set-cookie，后续 /api 请求必须带上它）；
 * 6. 调 /stats 看机制是否可用，调 /trim 强制回收一次；
 * 7. 断言并清理。
 *
 * 用法：node scripts/selftest.mjs
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm, cp } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DSH = process.env.DSH_CLI ?? 'dsh'
const REAL_HOME = join(homedir(), '.dsh')
const PROFILE = 'web'

const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : '：' + detail}`)
  if (!ok) failures.push(name + (detail === '' ? '' : '（' + detail + '）'))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(label, probe, timeoutMs = 180000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== undefined && value !== null && value !== false) return value
    if (Date.now() > deadline) throw new Error('等待超时：' + label)
    await sleep(intervalMs)
  }
}

/**
 * 用启动令牌换会话 cookie。
 * @param {string} base - 实例根地址。
 * @param {string} token - 启动令牌。
 * @returns {Promise<string|null>} cookie 串；失败时返回 null。
 */
async function exchangeToken(base, token) {
  const response = await fetch(base + '/?token=' + encodeURIComponent(token), { redirect: 'manual' })
  const raw = response.headers.get('set-cookie')
  if (!raw) return null
  return raw.split(';')[0].trim()
}

let child = null
let home = null
try {
  home = await mkdtemp(join(tmpdir(), 'dsh-lowmem-selftest-'))
  console.log('临时 DSH_HOME：' + home)

  const source = join(REAL_HOME, 'profiles', PROFILE)
  if (!existsSync(source)) throw new Error('本机没有 ' + source + '，自检需要真实 web profile 的副本')
  await mkdir(join(home, 'profiles'), { recursive: true })
  await cp(source, join(home, 'profiles', PROFILE), { recursive: true })
  console.log('已复制 web profile')

  console.log('安装插件…')
  const install = spawnSync(DSH, ['plugin', '--profile', PROFILE, 'add', ROOT], {
    env: { ...process.env, DSH_HOME: home },
    encoding: 'utf8',
  })
  check('插件安装成功', install.status === 0, (install.stderr || install.stdout || '').slice(-300))

  console.log('复核合成配置…')
  const dump = spawnSync(DSH, ['--profile', PROFILE, '--dump-config'], {
    env: { ...process.env, DSH_HOME: home },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  const dumpText = (dump.stdout || '') + (dump.stderr || '')
  const ourIds = ['ui-trajectory', 'ptc-runtime', 'jobs', 'typert-gateway', 'session-projection-cache', 'spill-policy', 'dsh-lowmem']
  const missing = (dumpText.match(/patch: entry "[^"]+" not found/g) || [])
    .filter((line) => ourIds.some((id) => line.includes('"' + id + '"')))
  check('本插件覆盖的行没有 "entry not found"', missing.length === 0, missing.join('; '))
  const foreign = (dumpText.match(/patch: entry "[^"]+" not found/g) || []).filter((line) => !missing.includes(line))
  if (foreign.length > 0) console.log('  提示：本 profile 另有 ' + foreign.length + ' 条与本插件无关的既有告警：' + foreign.join('; '))
  check('宿主行已插入', /- id: dsh-lowmem/.test(dumpText))
  check('ui-trajectory 覆盖生效', /maxResultsPerSession: 200/.test(dumpText))
  check('ptc-runtime 覆盖生效', /maxOutputBytes: 8388608/.test(dumpText))
  check('session-projection-cache 覆盖生效', /writeEveryEvents: 50/.test(dumpText))

  console.log('起临时实例…')
  child = spawn(DSH, ['--profile', PROFILE, '--no-open', '--port', '0'], {
    env: { ...process.env, DSH_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (d) => { output += d.toString() })
  child.stderr.on('data', (d) => { output += d.toString() })

  const url = await waitFor('实例打印启动地址', async () => {
    const m = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/)
    return m ? m[0] : null
  })
  const base = url.replace(/\/\?token=.*$/, '')
  const token = url.split('token=')[1]
  console.log('临时实例：' + base)

  const cookie = await exchangeToken(base, token)
  check('启动令牌换到会话 cookie', typeof cookie === 'string' && cookie.length > 0)

  const call = async (path, init = {}) => {
    const response = await fetch(base + path, {
      ...init,
      headers: { ...(init.headers ?? {}), cookie },
    })
    const text = await response.text()
    let body
    try { body = JSON.parse(text) } catch { body = { raw: text } }
    return { status: response.status, body }
  }

  const stats = await waitFor('stats 接口可用', async () => {
    const result = await call('/api/dsh-lowmem/stats')
    return result.status === 200 && result.body.memory ? result.body : null
  })

  check('stats 返回内存快照', typeof stats.memory.rssBytes === 'number' && stats.memory.rssBytes > 0,
    'rss=' + Math.round(stats.memory.rssBytes / 1048576) + ' MiB')
  check('平台识别正确', typeof stats.platform === 'string' && stats.platform.length > 0, stats.platform)
  check('原生机制可用', stats.mechanism.available === true, stats.mechanism.name + ' / ' + stats.mechanism.detail)

  const trimmed = await call('/api/dsh-lowmem/trim', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ force: true }),
  })
  check('trim 接口返回成功', trimmed.status === 200 && trimmed.body.ok === true, JSON.stringify(trimmed.body).slice(0, 160))
  check('trim 报告了释放量', typeof trimmed.body.reclaimedBytes === 'number' && trimmed.body.reclaimedBytes >= 0,
    'reclaimed=' + trimmed.body.reclaimedBytes)
  check('trim 耗时在合理范围', typeof trimmed.body.durationMs === 'number' && trimmed.body.durationMs < 5000,
    trimmed.body.durationMs + ' ms')
  console.log('  回收前 RSS ' + Math.round((trimmed.body.before?.rssBytes ?? 0) / 1048576) + ' MiB → 回收后 RSS '
    + Math.round((trimmed.body.after?.rssBytes ?? 0) / 1048576) + ' MiB（释放 '
    + Math.round((trimmed.body.reclaimedBytes ?? 0) / 1048576) + ' MiB，耗时 ' + trimmed.body.durationMs + ' ms）')

  const after = await call('/api/dsh-lowmem/stats')
  check('统计里记录了这次回收', after.body.trim.count >= 1, 'count=' + after.body.trim.count)
  check('累计回收量已累计', after.body.trim.totalReclaimedBytes >= trimmed.body.reclaimedBytes)

  const config = await call('/api/dsh-lowmem/config')
  check('config 接口返回配置', config.status === 200 && typeof config.body.config === 'object'
    && typeof config.body.config.thresholdBytes === 'number', JSON.stringify(config.body).slice(0, 120))

  const updated = await call('/api/dsh-lowmem/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ thresholdBytes: 128 * 1024 * 1024 }),
  })
  check('config 可写回', updated.status === 200 && updated.body.config.thresholdBytes === 128 * 1024 * 1024,
    JSON.stringify(updated.body).slice(0, 120))
} catch (error) {
  check('自检流程没有异常', false, error instanceof Error ? error.message : String(error))
} finally {
  if (child && !child.killed) {
    child.kill('SIGTERM')
    await sleep(1500)
    if (!child.killed) child.kill('SIGKILL')
  }
  if (home) await rm(home, { recursive: true, force: true }).catch(() => {})
}

console.log('')
if (failures.length > 0) {
  console.log('自检失败 ' + failures.length + ' 项：')
  for (const f of failures) console.log('  - ' + f)
  process.exitCode = 1
} else {
  console.log('自检全部通过')
}
