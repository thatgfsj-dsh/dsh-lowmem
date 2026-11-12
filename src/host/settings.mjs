/**
 * 插件自己的配置：默认值、白名单校验、落盘读写。
 *
 * 为什么不走宿主的配置层改阈值：宿主把官方插件的 config 在构造时深冻结，
 * 且由 patch 插入的行"运行期自我修改不跨重启保留"。
 * 所以本插件的配置自己管、自己落盘（~/.dsh/dsh-lowmem/settings.json）。
 *
 * @module dsh-lowmem/host/settings
 */
import os from 'node:os'
import path from 'node:path'
import { promises as fsp } from 'node:fs'

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
  thresholdBytes: 256 * 1024 * 1024,
  minIntervalMs: 60_000,
  idleIntervalMs: 300_000,
  hardCapBytes: 3 * 1024 * 1024 * 1024,
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
 * 校验并合并一段配置补丁。
 *
 * 只接受白名单键，且每个键都做类型与范围校验——
 * 配置文件是用户可写的，坏值会让整个插件行为变得不可预期。
 * @param {Record<string, unknown>} base - 当前配置。
 * @param {Record<string, unknown>} patch - 待合并的补丁。
 * @returns {Record<string, unknown>} 合并后的配置（未通过校验的键被忽略）。
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
        if (value === 'minor' || value === 'major') next[key] = value
        break
      default: {
        const numeric = Number(value)
        if (!Number.isFinite(numeric) || numeric < 0) break
        if (key === 'minIntervalMs' || key === 'idleIntervalMs' || key === 'sampleIntervalMs') {
          next[key] = Math.floor(numeric)
        } else {
          next[key] = Math.floor(numeric)
        }
      }
    }
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
 * 把配置写回磁盘。
 * @param {Record<string, unknown>} config - 要保存的配置。
 * @returns {Promise<boolean>} 是否写成功。
 */
export async function writeSettings(config) {
  try {
    const file = settingsPath()
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await fsp.writeFile(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}
