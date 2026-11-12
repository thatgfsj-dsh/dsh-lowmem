/**
 * 回收触发策略的单测：纯函数，无 IO、无计时器。
 *
 * 判定顺序（docs/CONTRACT.md §2.3，先命中先返回）是这个文件的主角：
 * | 1 | !enabled → disabled |
 * | 2 | rss >= hardCapBytes → hard-cap |
 * | 3 | 增长 >= thresholdBytes 且过了 minIntervalMs 且 !activeTurn → threshold |
 * | 4 | 空闲 >= idleIntervalMs 且过了 minIntervalMs → idle |
 * | 5 | 其它 → below-threshold |
 *
 * 顺序本身是有后果的：hard-cap 在 activeTurn 之前，所以硬上限必须带下界（§2.4）；
 * threshold 在 idle 之前，所以"增长够但正在跑会话"会落到 below-threshold 而不是 idle。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decideTrim } from '../src/host/policy.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

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

/* ------------------------------------------------------------------ *
 * 判定顺序：写死顺序的用例
 * ------------------------------------------------------------------ */

test('顺序：disabled 先于 hard-cap', () => {
  // 关掉开关时，即使 RSS 已经爆表也不能回收。
  const result = decideTrim(
    { ...STATE, rssBytes: CONFIG.hardCapBytes + 1, activeTurn: true },
    { ...CONFIG, enabled: false },
    10_000_000,
  )
  assert.equal(result.should, false)
  assert.equal(result.reason, 'disabled')
})

test('顺序：hard-cap 先于 activeTurn', () => {
  // 正在跑会话（activeTurn=true）也必须硬上限优先回收，否则内存会一路涨到宿主被杀。
  const now = 10_000_000
  const result = decideTrim(
    {
      rssBytes: CONFIG.hardCapBytes,
      lastTrimAt: now,                    // 距上次回收 0 ms，远小于 minIntervalMs
      lastTrimRssBytes: 0,
      activeTurn: true,                   // 正在跑会话
      lastActivityAt: now,
    },
    CONFIG,
    now,
  )
  assert.equal(result.should, true)
  assert.equal(result.reason, 'hard-cap')
})

test('顺序：hard-cap 先于 minIntervalMs', () => {
  // 距上次回收不到 minIntervalMs，硬上限照样触发。
  const now = 10_000_000
  const result = decideTrim(
    {
      rssBytes: CONFIG.hardCapBytes + 1,
      lastTrimAt: now - 1,
      lastTrimRssBytes: 0,
      activeTurn: false,
      lastActivityAt: now,
    },
    CONFIG,
    now,
  )
  assert.equal(result.should, true)
  assert.equal(result.reason, 'hard-cap')
})

test('顺序：hard-cap 命中时，阈值与空闲路径都同时满足也只报 hard-cap', () => {
  // 三条路径同时满足 → 先命中的那条赢（契约 §2.3 的表是"先命中先返回"）。
  const now = 10_000_000
  const result = decideTrim(
    {
      rssBytes: CONFIG.hardCapBytes + 1,
      lastTrimAt: now - CONFIG.minIntervalMs,
      lastTrimRssBytes: 0,
      activeTurn: false,
      lastActivityAt: now - CONFIG.idleIntervalMs,
    },
    CONFIG,
    now,
  )
  assert.equal(result.should, true)
  assert.equal(result.reason, 'hard-cap')
})

test('顺序：threshold 先于 idle', () => {
  // 增长到阈值且空闲 → 报 threshold（不是 idle）。
  const now = 10_000_000
  const result = decideTrim(
    {
      rssBytes: STATE.lastTrimRssBytes + CONFIG.thresholdBytes,
      lastTrimAt: now - CONFIG.minIntervalMs,
      lastTrimRssBytes: STATE.lastTrimRssBytes,
      activeTurn: false,
      lastActivityAt: now - CONFIG.idleIntervalMs,
    },
    CONFIG,
    now,
  )
  assert.equal(result.should, true)
  assert.equal(result.reason, 'threshold')
})

test('顺序：idle 路径也要过 minIntervalMs', () => {
  const now = 10_000_000
  const result = decideTrim(
    {
      rssBytes: STATE.lastTrimRssBytes,
      lastTrimAt: now - 1000,               // 距上次回收只有 1 s
      lastTrimRssBytes: STATE.lastTrimRssBytes,
      activeTurn: false,
      lastActivityAt: now - CONFIG.idleIntervalMs,
    },
    CONFIG,
    now,
  )
  assert.equal(result.should, false)
  assert.equal(result.reason, 'below-threshold')
})

test('activeTurn=true 时即使超过阈值也不回收（阈值路径要求空闲）', () => {
  const now = 10_000_000
  const result = decideTrim(
    {
      rssBytes: STATE.lastTrimRssBytes + CONFIG.thresholdBytes * 4,
      lastTrimAt: now - CONFIG.minIntervalMs,
      lastTrimRssBytes: STATE.lastTrimRssBytes,
      activeTurn: true,
      lastActivityAt: now,                 // 刚有活动 → 空闲兜底也不成立
    },
    CONFIG,
    now,
  )
  assert.equal(result.should, false)
  assert.equal(result.reason, 'below-threshold')
})

test('activeTurn=false 且刚有活动时，阈值路径成立', () => {
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

/* ------------------------------------------------------------------ *
 * 红线 #10：失败回收不清零阈值基线（controller 层）
 * ------------------------------------------------------------------ */

/**
 * 把源码里的字符串 / 模板 / 注释替换成等长空格（保留换行）。
 * 这样再用括号配对找函数体时，不会被模板字符串里的 ${} 干扰。
 * @param {string} source - 源码。
 * @returns {string} 掩码后的源码（长度不变）。
 */
function maskLiterals(source) {
  const out = source.split('')
  /**
   * @param {number} from - 起点。
   * @param {number} to - 终点（不含）。
   * @returns {void}
   */
  const blank = (from, to) => {
    for (let i = from; i < to && i < out.length; i++) {
      if (out[i] !== '\n') out[i] = ' '
    }
  }
  let i = 0
  while (i < source.length) {
    const ch = source[i]
    if (ch === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i)
      const stop = end === -1 ? source.length : end
      blank(i, stop)
      i = stop
      continue
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2)
      const stop = end === -1 ? source.length : end + 2
      blank(i, stop)
      i = stop
      continue
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1
      while (j < source.length && source[j] !== ch) {
        if (source[j] === '\\') j++
        j++
      }
      blank(i, Math.min(j + 1, source.length))
      i = j + 1
      continue
    }
    if (ch === '`') {
      let j = i + 1
      while (j < source.length) {
        if (source[j] === '\\') {
          j += 2
          continue
        }
        if (source[j] === '`') break
        if (source[j] === '$' && source[j + 1] === '{') {
          let depth = 1
          j += 2
          while (j < source.length && depth > 0) {
            const c = source[j]
            if (c === '{') depth++
            else if (c === '}') depth--
            else if (c === '"' || c === "'") {
              let k = j + 1
              while (k < source.length && source[k] !== c) {
                if (source[k] === '\\') k++
                k++
              }
              j = k
            }
            j++
          }
          continue
        }
        j++
      }
      blank(i, Math.min(j + 1, source.length))
      i = j + 1
      continue
    }
    i++
  }
  return out.join('')
}

/**
 * 找出某个具名函数的函数体范围（基于掩码后的源码，括号配对不会被骗）。
 * @param {string} masked - 掩码后的源码。
 * @param {string} functionName - 函数名。
 * @returns {{start: number, end: number}|null} 函数体范围。
 */
function findFunctionBody(masked, functionName) {
  const index = masked.indexOf('function ' + functionName)
  if (index === -1) return null
  const open = masked.indexOf('{', index)
  if (open === -1) return null
  let depth = 0
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === '{') depth++
    else if (masked[i] === '}') {
      depth--
      if (depth === 0) return { start: open, end: i }
    }
  }
  return null
}

/**
 * 判断"给 lastTrimRssBytes 赋值"这句是否落在了成功分支里。
 *
 * 接受这些写法（都是"失败不清零基线"的等价表达）：
 * - `if (outcome.ok) { … lastTrimRssBytes = … }`
 * - `if (!outcome.ok) { … } else { … lastTrimRssBytes = … }`
 * - `if (!outcome.ok) { … return … }` 之后才赋值
 * - `lastTrimRssBytes = outcome.ok ? after.rssBytes : lastTrimRssBytes`
 * @param {string} source - controller.mjs 源码。
 * @returns {{guarded: boolean, reason: string}} 检查结果。
 */
export function checkBaselineGuard(source) {
  const masked = maskLiterals(source)
  const body = findFunctionBody(masked, 'performTrim')
  if (body === null) return { guarded: false, reason: '找不到 performTrim 函数' }

  const assignment = masked.indexOf('lastTrimRssBytes =', body.start)
  if (assignment === -1 || assignment > body.end) {
    return { guarded: false, reason: 'performTrim 里没有给 lastTrimRssBytes 赋值' }
  }

  // 赋值语句本身：到分号或换行为止
  let statementEnd = assignment
  while (statementEnd < masked.length && masked[statementEnd] !== ';' && masked[statementEnd] !== '\n') statementEnd++
  const statement = source.slice(assignment, statementEnd)
  if (/\bok\b/.test(statement)) {
    return { guarded: true, reason: '赋值语句自身带了成功判定（三元表达式）' }
  }

  // 赋值之前的所有 if 条件（从后往前找）
  const conditions = []
  const head = masked.slice(body.start, assignment)
  const re = /if\s*\(([^)]*)\)/g
  let match = re.exec(head)
  while (match !== null) {
    conditions.push({ cond: match[1].trim(), start: match.index, end: match.index + match[0].length })
    match = re.exec(head)
  }

  for (let i = conditions.length - 1; i >= 0; i--) {
    const { cond, end } = conditions[i]
    if (!/\bok\b/.test(cond)) continue
    const negative = /!\s*(\()?\s*(outcome\.)?ok\b/.test(cond)
    const between = head.slice(end)
    if (!negative) {
      return { guarded: true, reason: `赋值落在「${cond}」的成功分支里` }
    }
    if (/\belse\b/.test(between)) {
      return { guarded: true, reason: '赋值落在失败分支的 else 里（即成功分支）' }
    }
    if (/\breturn\b/.test(between)) {
      return { guarded: true, reason: '失败分支提前 return，赋值不会被执行到' }
    }
    return { guarded: false, reason: `赋值落在「${cond}」的失败分支里，失败会清零阈值基线` }
  }

  return { guarded: false, reason: '赋值没有任何成功判定包裹' }
}

test('红线 #10：失败回收不能清零阈值基线（controller 层）', async () => {
  const source = await readFile(join(ROOT, 'src/host/controller.mjs'), 'utf8')
  const result = checkBaselineGuard(source)
  assert.ok(result.guarded, '失败回收不能更新阈值基线：' + result.reason)
})

test('红线 #10 的检查本身能证伪（拿一份"失败也清零"的写法试）', async () => {
  const source = await readFile(join(ROOT, 'src/host/controller.mjs'), 'utf8')
  // 把成功守卫拆掉：无论成功失败都更新基线 —— 检查必须报红。
  const broken = source.replace(
    /if \(!outcome\.ok\) \{[\s\S]*?\} else \{\n([\s\S]*?)\n([\s\S]*?)\n([\s\S]*?)\n([\s\S]*?)\n([\s\S]*?)\n([\s\S]*?)\n([\s\S]*?)\n\s*\}/,
    (match) => match.replace(/\} else \{/, '}\n      if (true) {'),
  )
  assert.notEqual(broken, source, '变异没有生效')
  const result = checkBaselineGuard(broken)
  assert.equal(result.guarded, false, '把成功守卫拆掉之后，检查必须报红')
})
