/**
 * 配置层的单测：白名单 + **下界**（docs/CONTRACT.md §2.4）。
 *
 * 下界不是"建议"，是防事故的硬约束：
 * - `hardCapBytes` 的判定**先于** `activeTurn` 与 `minIntervalMs`（policy.mjs），
 *   所以 hardCapBytes=0 会让"是否回收"恒为真——每 15 秒无条件 trim 一次，
 *   用户正在跑会话也照收；
 * - `thresholdBytes` 低于 16 MiB 会被宿主正常的内存增长反复触发，等于没有阈值；
 * - `gcMode='major-snapshot'` 实测耗时 10.7 s 且把 RSS 顶高 777 MB，绝不放行。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CONFIG, CONFIG_KEYS, mergeConfig } from '../src/host/settings.mjs'
import * as settingsModule from '../src/host/settings.mjs'

const MB = 1024 * 1024

/** 契约 §2.4 的下界。 */
const MIN = {
  thresholdBytes: 16 * MB,
  hardCapBytes: 256 * MB,
  minIntervalMs: 5_000,
  idleIntervalMs: 30_000,
  sampleIntervalMs: 1_000,
}

test('默认配置包含全部白名单键', () => {
  for (const key of CONFIG_KEYS) {
    assert.ok(key in DEFAULT_CONFIG, `默认配置缺少 ${key}`)
  }
})

test('白名单外的键被忽略', () => {
  const merged = mergeConfig(DEFAULT_CONFIG, { evil: 1, enabled: false })
  assert.equal('evil' in merged, false)
  assert.equal(merged.enabled, false)
})

test('非布尔 enabled 被忽略', () => {
  const merged = mergeConfig(DEFAULT_CONFIG, { enabled: 'yes' })
  assert.equal(merged.enabled, DEFAULT_CONFIG.enabled)
})

test('NaN 与非数字被忽略（保持原值）', () => {
  const merged = mergeConfig(DEFAULT_CONFIG, { thresholdBytes: 'abc', hardCapBytes: NaN })
  assert.equal(merged.thresholdBytes, DEFAULT_CONFIG.thresholdBytes)
  assert.equal(merged.hardCapBytes, DEFAULT_CONFIG.hardCapBytes)
})

test('合法数值会被取整写入', () => {
  // 取整要在下界之上验证：低于下界的值会被夹到下界（见下一组用例）。
  const merged = mergeConfig(DEFAULT_CONFIG, { thresholdBytes: 300 * MB + 0.9 })
  assert.equal(merged.thresholdBytes, 300 * MB)
})

test('gcMode 只接受 minor / major', () => {
  assert.equal(mergeConfig(DEFAULT_CONFIG, { gcMode: 'major' }).gcMode, 'major')
  assert.equal(mergeConfig(DEFAULT_CONFIG, { gcMode: 'minor' }).gcMode, 'minor')
  assert.equal(mergeConfig(DEFAULT_CONFIG, { gcMode: 'major-snapshot' }).gcMode, DEFAULT_CONFIG.gcMode)
})

test('补丁不是对象时返回原配置', () => {
  const merged = mergeConfig(DEFAULT_CONFIG, null)
  assert.deepEqual(merged, DEFAULT_CONFIG)
})

/* ------------------------------------------------------------------ *
 * 契约 §2.4：配置下界
 * ------------------------------------------------------------------ */

test('下界表与契约 §2.4 一致（若实现导出了这张表）', () => {
  const bounds = settingsModule.CONFIG_BOUNDS
  if (bounds === undefined) return
  for (const [key, min] of Object.entries(MIN)) {
    assert.ok(bounds[key] !== undefined, `下界表缺少 ${key}`)
    assert.equal(bounds[key].min, min, `${key} 的下界应当是 ${min}`)
  }
})

test('默认配置自身就满足全部下界', () => {
  for (const [key, min] of Object.entries(MIN)) {
    assert.ok(DEFAULT_CONFIG[key] >= min, `默认 ${key}=${DEFAULT_CONFIG[key]} 低于下界 ${min}`)
  }
  assert.ok(DEFAULT_CONFIG.hardCapBytes > DEFAULT_CONFIG.thresholdBytes, '硬上限必须高于阈值')
  assert.ok(['minor', 'major'].includes(DEFAULT_CONFIG.gcMode), '默认 gcMode 只能是 minor / major')
})

test('thresholdBytes 低于 16 MiB 被夹到 16 MiB', () => {
  for (const value of [0, 1, 1024, 8 * MB, 16 * MB - 1]) {
    const merged = mergeConfig(DEFAULT_CONFIG, { thresholdBytes: value })
    assert.equal(merged.thresholdBytes, 16 * MB, `thresholdBytes=${value} 应当被夹到 16 MiB`)
  }
})

test('thresholdBytes 不低于 16 MiB 时原样保留', () => {
  const merged = mergeConfig(DEFAULT_CONFIG, { thresholdBytes: 64 * MB })
  assert.equal(merged.thresholdBytes, 64 * MB)
})

test('hardCapBytes 低于 256 MiB 被夹到 256 MiB', () => {
  // 阈值取下界（16 MiB）时，硬上限正好落在 256 MiB。
  for (const value of [0, 1, 1024, 64 * MB, 256 * MB - 1]) {
    const merged = mergeConfig(DEFAULT_CONFIG, { thresholdBytes: 16 * MB, hardCapBytes: value })
    assert.equal(merged.hardCapBytes, 256 * MB, `hardCapBytes=${value} 应当被夹到 256 MiB`)
  }
})

test('hardCapBytes 低于 256 MiB 时仍必须高于阈值', () => {
  // 默认阈值是 256 MiB，硬上限又必须严格大于阈值 → 夹取后的值至少要高一档。
  for (const value of [0, 1, 1024, 64 * MB, 256 * MB - 1]) {
    const merged = mergeConfig(DEFAULT_CONFIG, { hardCapBytes: value })
    assert.ok(merged.hardCapBytes >= 256 * MB, `hardCapBytes=${value} 夹取后不能低于 256 MiB`)
    assert.ok(
      merged.hardCapBytes > merged.thresholdBytes,
      `hardCapBytes=${merged.hardCapBytes} 必须大于 thresholdBytes=${merged.thresholdBytes}`,
    )
  }
})

test('hardCapBytes 必须严格大于 thresholdBytes', () => {
  const cases = [
    { thresholdBytes: 2 * 1024 * MB, hardCapBytes: 1 * 1024 * MB },
    { thresholdBytes: 512 * MB, hardCapBytes: 256 * MB },
    { thresholdBytes: 300 * MB, hardCapBytes: 300 * MB },
    { thresholdBytes: 400 * MB, hardCapBytes: 0 },
  ]
  for (const patch of cases) {
    const merged = mergeConfig(DEFAULT_CONFIG, patch)
    assert.ok(
      merged.hardCapBytes > merged.thresholdBytes,
      `hardCapBytes(${merged.hardCapBytes}) 必须大于 thresholdBytes(${merged.thresholdBytes})`,
    )
    assert.ok(merged.hardCapBytes >= MIN.hardCapBytes, '硬上限不能被夹到 256 MiB 以下')
  }
})

test('minIntervalMs 低于 5 s 被夹到 5 s', () => {
  for (const value of [0, 1, 1000, 4999]) {
    const merged = mergeConfig(DEFAULT_CONFIG, { minIntervalMs: value })
    assert.equal(merged.minIntervalMs, 5_000, `minIntervalMs=${value} 应当被夹到 5000`)
  }
})

test('idleIntervalMs 低于 30 s 被夹到 30 s', () => {
  for (const value of [0, 1, 1000, 29_999]) {
    const merged = mergeConfig(DEFAULT_CONFIG, { idleIntervalMs: value })
    assert.equal(merged.idleIntervalMs, 30_000, `idleIntervalMs=${value} 应当被夹到 30000`)
  }
})

test('sampleIntervalMs 低于 1 s 被夹到 1 s', () => {
  for (const value of [0, 1, 500, 999]) {
    const merged = mergeConfig(DEFAULT_CONFIG, { sampleIntervalMs: value })
    assert.equal(merged.sampleIntervalMs, 1_000, `sampleIntervalMs=${value} 应当被夹到 1000`)
  }
})

test('负数同样被夹到下界（不是"忽略"）', () => {
  // 契约 §2.4 的表述是"低于下界就夹到下界"：负数同样低于下界。
  // 忽略负数会留下一个 0 值，等于把 §2.4 的保护绕过去了。
  const merged = mergeConfig(DEFAULT_CONFIG, {
    thresholdBytes: -1,
    hardCapBytes: -1,
    minIntervalMs: -1,
    idleIntervalMs: -1,
    sampleIntervalMs: -1,
  })
  assert.equal(merged.thresholdBytes, 16 * MB)
  assert.equal(merged.hardCapBytes, 256 * MB)
  assert.equal(merged.minIntervalMs, 5_000)
  assert.equal(merged.idleIntervalMs, 30_000)
  assert.equal(merged.sampleIntervalMs, 1_000)
})

test('gcMode=major-snapshot 被拒绝（实测 10.7 s 且把 RSS 顶到 777 MB）', () => {
  const merged = mergeConfig(DEFAULT_CONFIG, { gcMode: 'major-snapshot' })
  assert.notEqual(merged.gcMode, 'major-snapshot')
  assert.ok(['minor', 'major'].includes(merged.gcMode))
})

test('下界在连续合并后依然成立', () => {
  let config = { ...DEFAULT_CONFIG }
  config = mergeConfig(config, { thresholdBytes: 1, hardCapBytes: 1, minIntervalMs: 1, idleIntervalMs: 1, sampleIntervalMs: 1 })
  config = mergeConfig(config, { thresholdBytes: 1, hardCapBytes: 1 })
  for (const [key, min] of Object.entries(MIN)) {
    assert.ok(config[key] >= min, `${key}=${config[key]} 低于下界 ${min}`)
  }
  assert.ok(config.hardCapBytes > config.thresholdBytes)
})
