import test from 'node:test'
import assert from 'node:assert/strict'
import { sampleMemory } from '../src/host/sampler.mjs'

test('采样返回全部字段且类型正确', () => {
  const sample = sampleMemory()
  for (const key of [
    'rssBytes', 'heapTotalBytes', 'heapUsedBytes',
    'externalBytes', 'arrayBufferBytes', 'uptimeSeconds', 'pid',
  ]) {
    assert.equal(typeof sample[key], 'number', `${key} 应为数字`)
    assert.ok(Number.isFinite(sample[key]), `${key} 应为有限值`)
  }
})

test('pid 与当前进程一致', () => {
  assert.equal(sampleMemory().pid, process.pid)
})

test('RSS 不小于 heapUsed', () => {
  const sample = sampleMemory()
  assert.ok(sample.rssBytes >= sample.heapUsedBytes)
})
