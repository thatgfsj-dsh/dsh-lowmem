/**
 * 临时 DSH 实例：给自检与 UI 冒烟共用。
 *
 * 用**真实 web profile 的副本**而不是最小 profile：最小 profile 缺宿主接线，
 * /api 路由会整体 404（连官方插件的路由也是 404），测不出真实行为。
 *
 * 副本跑在临时 DSH_HOME 里，不碰线上 dsh web 与真实会话。
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, cp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

export const REAL_HOME = join(homedir(), '.dsh')
export const PROFILE = 'web'
export const DSH = process.env.DSH_CLI ?? 'dsh'

/** 等待某个条件成立。 */
export async function waitFor(label, probe, timeoutMs = 180000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== undefined && value !== null && value !== false) return value
    if (Date.now() > deadline) throw new Error('等待超时：' + label)
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

/**
 * 用启动令牌换会话 cookie（宿主把 /api 放在浏览器信任栅栏后面）。
 * @param {string} base - 实例根地址。
 * @param {string} token - 启动令牌。
 * @returns {Promise<string|null>} cookie 串。
 */
export async function exchangeToken(base, token) {
  const response = await fetch(base + '/?token=' + encodeURIComponent(token), { redirect: 'manual' })
  const raw = response.headers.get('set-cookie')
  return raw === null ? null : raw.split(';')[0].trim()
}

/**
 * 起一个临时 DSH 实例。
 * @param {string} pluginPath - 要装进临时 profile 的插件目录。
 * @returns {Promise<{base: string, cookie: string, home: string, child: object, stop: () => Promise<void>}>} 实例句柄。
 */
export async function startTempInstance(pluginPath) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-lowmem-instance-'))
  const source = join(REAL_HOME, 'profiles', PROFILE)
  if (!existsSync(source)) throw new Error('本机没有 ' + source + '，临时实例需要真实 web profile 的副本')
  await mkdir(join(home, 'profiles'), { recursive: true })
  await cp(source, join(home, 'profiles', PROFILE), { recursive: true })

  const install = spawnSync(DSH, ['plugin', '--profile', PROFILE, 'add', pluginPath], {
    env: { ...process.env, DSH_HOME: home },
    encoding: 'utf8',
  })
  if (install.status !== 0) {
    await rm(home, { recursive: true, force: true }).catch(() => {})
    throw new Error('插件安装失败：' + (install.stderr || install.stdout || '').slice(-300))
  }

  const child = spawn(DSH, ['--profile', PROFILE, '--no-open', '--port', '0'], {
    env: { ...process.env, DSH_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk) => { output += String(chunk) })
  child.stderr.on('data', (chunk) => { output += String(chunk) })

  const url = await waitFor('实例打印启动地址', async () => {
    const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/)
    return match === null ? null : match[0]
  })
  const base = url.replace(/\/\?token=.*$/, '')
  const token = url.split('token=')[1]
  const cookie = await exchangeToken(base, token)
  if (cookie === null) throw new Error('没拿到会话 cookie')

  return {
    base,
    url,
    token,
    cookie,
    home,
    child,
    output: () => output,
    /**
     * 调一次接口。
     * @param {string} path - 接口路径。
     * @param {RequestInit} [init] - 请求选项。
     * @returns {Promise<{status: number, body: object}>} 响应。
     */
    async call(path, init = {}) {
      const response = await fetch(base + path, {
        ...init,
        headers: { ...(init.headers ?? {}), cookie },
      })
      const text = await response.text()
      let body
      try { body = JSON.parse(text) } catch { body = { raw: text } }
      return { status: response.status, body }
    },
    /**
     * 关掉实例并清理临时目录。
     * @returns {Promise<void>} 清理完成。
     */
    async stop() {
      child.kill('SIGTERM')
      await new Promise((resolve) => setTimeout(resolve, 1500))
      if (!child.killed) child.kill('SIGKILL')
      await rm(home, { recursive: true, force: true }).catch(() => {})
    },
  }
}
