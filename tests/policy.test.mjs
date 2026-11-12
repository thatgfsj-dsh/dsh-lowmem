import test from 'node:test'
import assert from 'node:assert/strict'
import { decideTrim } from '../src/host/policy.mjs'

const CONFIG = {
  enabled: true,
  thresholdBytes: 256 * 1024 * 1024,
  minIntervalMs: 60_000,
  idleIntervalMs: 300_000,
  hardCapBytes: 3 * 1024 * 1024 * 1024,
  sampleIntervalMs: 15_000,
}

const STATE = {
  rssBytes: 1024 * 1024 * 1024,
  lastTrimAt: 0,
  lastTrimRssBytes: 1024 * 1024 * 1024,
  activeTurn: false,
  lastActivityAt: 0,
}

test('禁用时永不回收', () => {
  const result = decideTrim({ ...STATE, rssBytes: 99 * 1024 ** 3 }, { ...CONFIG, enabled: false }, 1_000_000)
  assert.equal(result.should, false)
  assert.equal(result.reason, 'disabled')
})

test('超过硬上限时立即回收，不看空闲也不看间隔', () => {
  const result = decideTrim(
    { ...STATE, rssBytes: CONFIG.hardCapBytes + 1, activeTurn: true, lastTrimAt: 1_000_000 },
    CONFIG,
    1_000_001,
  )
  assert.equal(result.should, true)
  assert.equal(result.reason, 'hard-cap')
})

test('增长超过阈值且空闲且过了最小间隔 → 回收', () => {
  const now = 10_000_000
  const result = decideTrim(
    {
      rssBytes: STATE.lastTrimRssBytes + CONFIG.thresholdBytes,
      lastTrimAt: now - CONFIG.minIntervalMs,
      lastTrimRssBytes: STATE.lastTrimRssBytes,
      activeTurn: false,
      lastActivityAt: now,
    },
    CONFIG,
    now,
  )
  assert.equal(result.should, true)
  assert.equal(result.reason, 'threshold')
})

test('增长超过阈值但仍在跑会话 → 不回收', () => {
  const now = 10_000_000
  const result = decideTrim(
    {
      rssBytes: STATE.lastTrimRssBytes + CONFIG.thresholdBytes,
      lastTrimAt: now - CONFIG.minIntervalMs,
      lastTrimRssBytes: STATE.lastTrimRssBytes,
      activeTurn: true,
      lastActivityAt: now,
    },
    CONFIG,
    now,
  )
  assert.equal(result.should, false)
  assert.equal(result.reason, 'below-threshold')
})

test('增长超过阈值但距上次回收不足最小间隔 → 不回收', () => {
  const now = 10_000_000
  const result = decideTrim(
    {
      rssBytes: STATE.lastTrimRssBytes + CONFIG.thresholdBytes,
      lastTrimAt: now - 1000,
      lastTrimRssBytes: STATE.lastTrimRssBytes,
      activeTurn: false,
      lastActivityAt: now,
    },
    CONFIG,
    now,
  )
  assert.equal(result.should, false)
})

test('空闲超过兜底间隔 → 回收（即使增长没到阈值）', () => {
  const now = 10_000_000
  const result = decideTrim(
    {
      rssBytes: STATE.lastTrimRssBytes,
      lastTrimAt: now - CONFIG.minIntervalMs,
      lastTrimRssBytes: STATE.lastTrimRssBytes,
      activeTurn: false,
      lastActivityAt: now - CONFIG.idleIntervalMs,
    },
    CONFIG,
    now,
  )
  assert.equal(result.should, true)
  assert.equal(result.reason, 'idle')
})

test('一切正常 → 不回收', () => {
  const now = 10_000_000
  const result = decideTrim(
    { ...STATE, lastTrimAt: now, lastActivityAt: now },
    CONFIG,
    now,
  )
  assert.equal(result.should, false)
  assert.equal(result.reason, 'below-threshold')
})
