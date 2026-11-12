import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CONFIG, CONFIG_KEYS, mergeConfig } from '../src/host/settings.mjs'

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

test('负数与 NaN 被忽略', () => {
  const merged = mergeConfig(DEFAULT_CONFIG, { thresholdBytes: -1, hardCapBytes: 'abc' })
  assert.equal(merged.thresholdBytes, DEFAULT_CONFIG.thresholdBytes)
  assert.equal(merged.hardCapBytes, DEFAULT_CONFIG.hardCapBytes)
})

test('合法数值会被取整写入', () => {
  const merged = mergeConfig(DEFAULT_CONFIG, { thresholdBytes: 1024.9 })
  assert.equal(merged.thresholdBytes, 1024)
})

test('gcMode 只接受 minor / major', () => {
  assert.equal(mergeConfig(DEFAULT_CONFIG, { gcMode: 'major' }).gcMode, 'major')
  assert.equal(mergeConfig(DEFAULT_CONFIG, { gcMode: 'major-snapshot' }).gcMode, DEFAULT_CONFIG.gcMode)
})

test('补丁不是对象时返回原配置', () => {
  const merged = mergeConfig(DEFAULT_CONFIG, null)
  assert.deepEqual(merged, DEFAULT_CONFIG)
})
