/**
 * 插件自己的配置：默认值、白名单校验、下界夹取、落盘读写。
 *
 * 为什么不走宿主的配置层改阈值：宿主把官方插件的 config 在构造时深冻结，
 * 且由 patch 插入的行"运行期自我修改不跨重启保留"。
 * 所以本插件的配置自己管、自己落盘（~/.dsh/dsh-lowmem/settings.json）。
 *
 * **下界是必须的**：判定顺序里 `hardCapBytes` 先于 `activeTurn` 与 `minIntervalMs`
 * （见 policy.mjs），所以 hardCapBytes=0 会让"是否回收"恒为真 —— 每 15 秒无条件 trim 一次，
 * 用户正在跑会话也照收。下界把这条路堵死。
 *
 * @module dsh-lowmem/host/settings
 */
import os from 'node:os'
import path from 'node:path'
import { promises as fsp } from 'node:fs'

const MB = 1024 * 1024

/**
 * 硬上限最多占物理内存的比例。
 *
 * 小内存机器上（32 位进程地址空间只有 4 GiB，或物理内存本身就小），
 * 把硬上限设成 3 GiB 之类的绝对值没有意义——进程会先被 OOM 干掉，
 * 根本等不到触发硬上限。所以按物理内存的比例封顶。
 */
const HARD_CAP_MEMORY_RATIO = 0.6

/**
 * 各键的下界与上界。写盘与内存态的校验都走这张表。
 * @type {Record<string, {min: number, max?: number}>}
 */
export const CONFIG_BOUNDS = {
  // 低于 16 MiB 会被宿主正常的内存增长反复触发，等于没有阈值。
  thresholdBytes: { min: 16 * MB },
  // 硬上限必须大于阈值，否则两条规则互相打架。
  hardCapBytes: { min: 256 * MB },
  // 两次回收之间至少留 5 秒，别把分配器逼成反复扩张/收缩。
  minIntervalMs: { min: 5_000 },
  // 空闲兜底也不该太频繁。
  idleIntervalMs: { min: 30_000 },
  // 采样周期下限 1 秒。
  sampleIntervalMs: { min: 1_000 },
}

/**
 * 默认配置。
 *
 * 取值理由：
 * - `thresholdBytes` 256 MiB：实测单次繁忙期 RSS 增长可达 ~100 MiB/分钟，
 *   256 MiB 意味着"忙完一轮再还"，不会频繁打断；
 * - `minIntervalMs` 60 s：给内核与分配器一点时间重新利用刚还回去的页；
 * - `idleIntervalMs` 5 min：空闲 5 分钟就还一次；
 * - `hardCapBytes` 3 GiB：超过就必须还，不管忙不忙；
 * - `sampleIntervalMs` 15 s：采样本身很便宜，15 s 足够；
 * - `gcEnabled` 默认关闭：实测强制 GC 只回收 ~9 MB，而 major GC 要 140 ms，
 *   收益不抵停顿；留给愿意手动开的用户。
 * @type {Record<string, unknown>}
 */
export const DEFAULT_CONFIG = {
  enabled: true,
  thresholdBytes: 256 * MB,
  minIntervalMs: 60_000,
  idleIntervalMs: 300_000,
  hardCapBytes: 3 * 1024 * MB,
  sampleIntervalMs: 15_000,
  gcEnabled: false,
  gcMode: 'minor',
}

/** 允许被写回的配置键（白名单：不在表里的键一律忽略）。 */
export const CONFIG_KEYS = Object.keys(DEFAULT_CONFIG)

/**
 * 定位 DSH 的家目录。
 * @returns {string} 家目录绝对路径。
 */
export function homeDir() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return path.join(os.homedir(), '.dsh')
}

/**
 * 配置文件路径。
 * @returns {string} 配置文件绝对路径。
 */
export function settingsPath() {
  return path.join(homeDir(), 'dsh-lowmem', 'settings.json')
}

/**
 * 把一个数值夹进它允许的区间。
 * @param {string} key - 配置键。
 * @param {number} value - 原值。
 * @returns {number} 夹取后的值。
 */
function clampToBounds(key, value) {
  const bounds = CONFIG_BOUNDS[key]
  if (bounds === undefined) return value
  let result = value
  if (result < bounds.min) result = bounds.min
  if (bounds.max !== undefined && result > bounds.max) result = bounds.max
  if (key === 'hardCapBytes') {
    // 按物理内存封顶：小内存机器上这个绝对值没有意义。
    const ceiling = Math.floor(os.totalmem() * HARD_CAP_MEMORY_RATIO)
    if (Number.isFinite(ceiling) && ceiling > 0 && result > ceiling) result = ceiling
  }
  return result
}

/**
 * 校验并合并一段配置补丁。
 *
 * 只接受白名单键，且每个键都做类型与范围校验——
 * 配置文件是用户可写的，坏值会让整个插件行为变得不可预期。
 * 越界的数值会被**夹到下界**（而不是忽略），这样用户在 UI 里填 0 也会得到一个安全值。
 * @param {Record<string, unknown>} base - 当前配置。
 * @param {Record<string, unknown>} patch - 待合并的补丁。
 * @returns {Record<string, unknown>} 合并后的配置。
 */
export function mergeConfig(base, patch) {
  const next = { ...base }
  if (patch === null || typeof patch !== 'object') return next
  for (const key of CONFIG_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue
    const value = patch[key]
    switch (key) {
      case 'enabled':
      case 'gcEnabled':
        if (typeof value === 'boolean') next[key] = value
        break
      case 'gcMode':
        // major-snapshot 实测 10.7 s 且顶高 RSS 777 MB，绝不放行。
        if (value === 'minor' || value === 'major') next[key] = value
        break
      default: {
        const numeric = Number(value)
        if (!Number.isFinite(numeric)) break
        next[key] = clampToBounds(key, Math.floor(numeric))
      }
    }
  }
  // 硬上限必须高于阈值，否则两条判定规则互相打架。
  if (next.hardCapBytes <= next.thresholdBytes) {
    next.hardCapBytes = clampToBounds('hardCapBytes', next.thresholdBytes * 2)
  }
  return next
}

/**
 * 读磁盘上的配置。
 *
 * 读不到 / 解析失败 / 内容不合法时都退回默认值：
 * 配置文件坏了不该让插件整个起不来。
 * @param {Record<string, unknown>} fallback - 兜底配置。
 * @returns {Promise<Record<string, unknown>>} 生效的配置。
 */
export async function readSettings(fallback) {
  try {
    const raw = await fsp.readFile(settingsPath(), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback
    return mergeConfig(fallback, parsed)
  } catch {
    return fallback
  }
}

/**
 * 只把**用户显式改过**的键写盘。
 *
 * 为什么不写整份配置：如果把行内默认也一起写进去，此后上游改了这个行的默认配置，
 * 本机就再也拿不到新默认值（"粘滞"）。只存差量，上游默认值仍然能透出来。
 * @param {Record<string, unknown>} overrides - 用户显式设置过的键值。
 * @returns {Promise<boolean>} 是否写成功。
 */
export async function writeSettings(overrides) {
  try {
    const file = settingsPath()
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await fsp.writeFile(file, `${JSON.stringify(overrides, null, 2)}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}
