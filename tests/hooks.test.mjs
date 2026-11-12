/**
 * 宿主事件挂载的结构单测：观察者与中间件的语义不能混用。
 *
 * `tools/result` 是 emit，返回值被忽略；`tools/pre-execute` 是 waterfall，
 * 监听器必须调用 next()，否则会否决整条链——宿主拿到的 gate 是 undefined，
 * 随后 `gate.kind` 抛 `Cannot read properties of undefined (reading 'kind')`，
 * 表现为所有工具调用一起失败。本文件锁住这一条契约。
 *
 * ## 为什么这一版要自己写扫描器
 *
 * 上一版用正则 `ctx\.on\(\s*'([^']+)'` 提取事件名，红队实测可以绕过去：
 *   - 双引号：`ctx.on("tools/result", …)` → 正则匹配不到，护栏形同虚设；
 *   - 反引号：`ctx.on(\`tools/result\`, …)` → 同上；
 *   - 注释伪装：`// next()` 里写一个 next()，静态检查就以为监听器调用了 next()。
 *
 * 所以这里改成**先词法分析再判断**：注释、字符串、正则一律不进"代码"，
 * 只有真正的调用形态（`next` 标识符紧跟 `(`）才算调用；
 * 事件名必须是静态字面量（单引号 / 双引号 / 无表达式的模板字符串），
 * 含 `${…}` 的动态模板一律判为违规。
 *
 * 护栏本身必须能被证伪，所以文件末尾有**变异测试**：把真实源码按各种绕过手法改坏，
 * 断言护栏每次都能抓住。绕过手法一旦失效，对应的变异用例会红。
 *
 * 环境变量 `DSH_LOWMEM_GUARD_ONLY=1`：只导出护栏函数、不注册用例
 * （给仓库外的变异演示脚本用，正常跑测试时不要设）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../index.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 宿主事件的分派模式（emit = 观察者，返回值被忽略；waterfall = 中间件，必须 next()）。
 *
 * 这份表是**白名单**：订阅表外的事件必须先把它分类并加进来，否则「每个订阅到的事件
 * 都已被分级」这条测试会失败。有了它，新增订阅时就不会再静默踩到 waterfall。
 *
 * 内容与 docs/CONTRACT.md §2.6 一一对应（那一节列的全是 emit，
 * 唯独 `tools/pre-execute` 是 waterfall）。
 */
export const KNOWN_EVENT_MODES = {
  'tools/pre-execute': 'waterfall',
  'tools/result': 'emit',
  'agent/status': 'emit',
  'agent/disposed': 'emit',
  'session/disposed': 'emit',
}

/** 只导入护栏函数时跳过用例注册。 */
const guardOnly = process.env.DSH_LOWMEM_GUARD_ONLY === '1'

/**
 * 注册一个用例；guardOnly 模式下什么都不做（只导出护栏函数）。
 * @param {string} name - 用例名。
 * @param {() => unknown} fn - 用例体。
 * @returns {void}
 */
function defineTest(name, fn) {
  if (!guardOnly) test(name, fn)
}

/* ------------------------------------------------------------------ *
 * 词法分析：把源码切成 token，注释/字符串/正则与代码彻底分开。
 * ------------------------------------------------------------------ */

/** 这些关键字后面出现的 `/` 是正则字面量，不是除号。 */
const KEYWORDS_BEFORE_REGEX = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'case', 'do', 'else', 'yield', 'await', 'throw',
])

/**
 * @param {string} ch - 字符。
 * @returns {boolean} 是否是标识符起始字符。
 */
function isIdentStart(ch) {
  return /[A-Za-z_$]/.test(ch)
}

/**
 * @param {string} ch - 字符。
 * @returns {boolean} 是否是标识符字符。
 */
function isIdentPart(ch) {
  return /[A-Za-z0-9_$]/.test(ch)
}

/**
 * 跳过一个字符串字面量。
 * @param {string} source - 源码。
 * @param {number} start - 起始引号位置。
 * @returns {number} 结束位置（不含）。
 */
function skipQuoted(source, start) {
  const quote = source[start]
  let i = start + 1
  while (i < source.length) {
    if (source[i] === '\\') {
      i += 2
      continue
    }
    if (source[i] === quote) return i + 1
    i++
  }
  return i
}

/**
 * 跳过一个模板字符串（含 `${…}` 表达式里的嵌套）。
 * @param {string} source - 源码。
 * @param {number} start - 起始反引号位置。
 * @returns {{end: number, hasExpr: boolean, text: string}} 扫描结果。
 */
function scanTemplate(source, start) {
  let i = start + 1
  let hasExpr = false
  let text = ''
  while (i < source.length) {
    const ch = source[i]
    if (ch === '\\') {
      text += source[i + 1] ?? ''
      i += 2
      continue
    }
    if (ch === '`') {
      i++
      break
    }
    if (ch === '$' && source[i + 1] === '{') {
      hasExpr = true
      text += '${…}'
      i = skipBalanced(source, i + 1)
      continue
    }
    text += ch
    i++
  }
  return { end: i, hasExpr, text }
}

/**
 * 跳过一段配对的括号（从 `{` 开始，返回 `}` 之后的位置）。
 * @param {string} source - 源码。
 * @param {number} start - `{` 的位置。
 * @returns {number} 结束位置。
 */
function skipBalanced(source, start) {
  let depth = 0
  let i = start
  while (i < source.length) {
    const ch = source[i]
    if (ch === '"' || ch === "'") {
      i = skipQuoted(source, i)
      continue
    }
    if (ch === '`') {
      i = scanTemplate(source, i).end
      continue
    }
    if (ch === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i)
      i = end === -1 ? source.length : end
      continue
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2)
      i = end === -1 ? source.length : end + 2
      continue
    }
    if (ch === '{') {
      depth++
      i++
      continue
    }
    if (ch === '}') {
      depth--
      i++
      if (depth === 0) return i
      continue
    }
    i++
  }
  return i
}

/**
 * 上一个 token 后面能不能出现正则字面量。
 * @param {object|null} prev - 上一个有意义的 token。
 * @returns {boolean} 是否按正则处理。
 */
function regexAllowed(prev) {
  if (prev === null) return true
  if (prev.type === 'number' || prev.type === 'string' || prev.type === 'template' || prev.type === 'regex') return false
  if (prev.type === 'name') return KEYWORDS_BEFORE_REGEX.has(prev.value)
  if (prev.type === 'punct') {
    return !(prev.value === ')' || prev.value === ']' || prev.value === '}' || prev.value === '++' || prev.value === '--')
  }
  return true
}

/**
 * 把源码切成 token。
 *
 * token 类型：comment / string / template / regex / name / number / punct。
 * 注释与字符串**内容**完整保留（报错信息要用），但它们不是"代码"。
 * @param {string} source - 源码。
 * @returns {Array<object>} token 列表。
 */
export function tokenize(source) {
  const tokens = []
  let i = 0
  let prev = null

  while (i < source.length) {
    const ch = source[i]

    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i++
      continue
    }
    if (ch === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i)
      const stop = end === -1 ? source.length : end
      tokens.push({ type: 'comment', value: source.slice(i, stop), start: i, end: stop })
      i = stop
      continue
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2)
      const stop = end === -1 ? source.length : end + 2
      tokens.push({ type: 'comment', value: source.slice(i, stop), start: i, end: stop })
      i = stop
      continue
    }
    if (ch === '"' || ch === "'") {
      const end = skipQuoted(source, i)
      const token = { type: 'string', value: source.slice(i + 1, end - 1), quote: ch, start: i, end }
      tokens.push(token)
      prev = token
      i = end
      continue
    }
    if (ch === '`') {
      const scanned = scanTemplate(source, i)
      const token = { type: 'template', value: scanned.text, hasExpr: scanned.hasExpr, start: i, end: scanned.end }
      tokens.push(token)
      prev = token
      i = scanned.end
      continue
    }
    if (ch === '/' && regexAllowed(prev)) {
      let j = i + 1
      let inClass = false
      let closed = false
      while (j < source.length) {
        const c = source[j]
        if (c === '\\') {
          j += 2
          continue
        }
        if (c === '\n') break
        if (c === '[') inClass = true
        else if (c === ']') inClass = false
        else if (c === '/' && !inClass) {
          closed = true
          break
        }
        j++
      }
      if (closed) {
        const end = j + 1
        const token = { type: 'regex', value: source.slice(i, end), start: i, end }
        tokens.push(token)
        prev = token
        i = end
        continue
      }
    }
    if (isIdentStart(ch)) {
      let j = i + 1
      while (j < source.length && isIdentPart(source[j])) j++
      const token = { type: 'name', value: source.slice(i, j), start: i, end: j }
      tokens.push(token)
      prev = token
      i = j
      continue
    }
    if (/[0-9]/.test(ch)) {
      let j = i
      while (j < source.length && /[0-9a-zA-Z._]/.test(source[j])) j++
      const token = { type: 'number', value: source.slice(i, j), start: i, end: j }
      tokens.push(token)
      prev = token
      i = j
      continue
    }
    // 标点：把多字符运算符合成一个 token（++ / -- / => / === 等）
    const three = source.slice(i, i + 3)
    const two = source.slice(i, i + 2)
    let value = ch
    if (['===', '!==', '...', '**=', '&&=', '||='].includes(three)) value = three
    else if (['=>', '==', '!=', '<=', '>=', '&&', '||', '++', '--', '+=', '-=', '*=', '/=', '??', '?.'].includes(two)) value = two
    const token = { type: 'punct', value, start: i, end: i + value.length }
    tokens.push(token)
    prev = token
    i += value.length
  }

  return tokens
}

/* ------------------------------------------------------------------ *
 * 在 token 流上做结构分析
 * ------------------------------------------------------------------ */

/**
 * 找到与 openIndex 处括号配对的右括号。
 * @param {Array<object>} tokens - token 列表。
 * @param {number} openIndex - 左括号 token 下标。
 * @param {string} [open] - 左括号字符。
 * @param {string} [close] - 右括号字符。
 * @returns {number} 右括号 token 下标；找不到则返回 tokens.length。
 */
function matchBracket(tokens, openIndex, open = '(', close = ')') {
  let depth = 0
  for (let i = openIndex; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.type !== 'punct') continue
    if (t.value === open) depth++
    else if (t.value === close) {
      depth--
      if (depth === 0) return i
    }
  }
  return tokens.length
}

/**
 * 把一次调用的实参按顶层逗号切开。
 * @param {Array<object>} tokens - token 列表。
 * @param {number} openIndex - 左括号 token 下标。
 * @param {number} closeIndex - 右括号 token 下标。
 * @returns {Array<Array<object>>} 每个实参的 token 片段。
 */
function splitArguments(tokens, openIndex, closeIndex) {
  const args = []
  let depth = 0
  let start = openIndex + 1
  for (let i = openIndex + 1; i < closeIndex; i++) {
    const t = tokens[i]
    if (t.type !== 'punct') continue
    if (t.value === '(' || t.value === '[' || t.value === '{') depth++
    else if (t.value === ')' || t.value === ']' || t.value === '}') depth--
    else if (t.value === ',' && depth === 0) {
      args.push(tokens.slice(start, i))
      start = i + 1
    }
  }
  if (start < closeIndex) args.push(tokens.slice(start, closeIndex))
  return args
}

/**
 * 取箭头函数（或函数表达式）的函数体 token。
 * @param {Array<object>} argTokens - 监听器实参的 token。
 * @returns {Array<object>|null} 函数体 token；不是函数字面量时返回 null。
 */
function extractFunctionBody(argTokens) {
  let i = 0
  if (argTokens[i] && argTokens[i].type === 'name' && argTokens[i].value === 'async') i++
  if (argTokens[i] && argTokens[i].type === 'name' && argTokens[i].value === 'function') {
    // function (...) { body }
    let j = i + 1
    if (argTokens[j] && argTokens[j].type === 'name') j++
    if (!argTokens[j] || argTokens[j].value !== '(') return null
    const close = matchBracket(argTokens, j)
    const brace = argTokens[close + 1]
    if (!brace || brace.type !== 'punct' || brace.value !== '{') return null
    const end = matchBracket(argTokens, close + 1, '{', '}')
    return argTokens.slice(close + 2, end)
  }
  if (argTokens[i] && argTokens[i].type === 'punct' && argTokens[i].value === '(') {
    const close = matchBracket(argTokens, i)
    i = close + 1
  } else if (argTokens[i] && argTokens[i].type === 'name') {
    i++
  } else {
    return null
  }
  const arrow = argTokens[i]
  if (!arrow || arrow.type !== 'punct' || arrow.value !== '=>') return null
  i++
  const first = argTokens[i]
  if (first && first.type === 'punct' && first.value === '{') {
    const end = matchBracket(argTokens, i, '{', '}')
    return argTokens.slice(i + 1, end)
  }
  // 表达式体：截到参数末尾
  return argTokens.slice(i)
}

/**
 * 在整个源码里找一个具名函数的函数体（监听器写成函数引用时用）。
 * @param {Array<object>} tokens - 全量 token。
 * @param {string} name - 函数名。
 * @returns {Array<object>|null} 函数体 token。
 */
function resolveNamedFunction(tokens, name) {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.type !== 'name' || t.value !== name) continue
    const next = tokens[i + 1]
    const prev = tokens[i - 1]
    // function name(...) { ... }
    if (prev && prev.type === 'name' && prev.value === 'function' && next && next.value === '(') {
      const close = matchBracket(tokens, i + 1)
      const brace = tokens[close + 1]
      if (brace && brace.type === 'punct' && brace.value === '{') {
        const end = matchBracket(tokens, close + 1, '{', '}')
        return tokens.slice(close + 2, end)
      }
    }
    // name = (...) => { ... } / name = async (...) => { ... } / name = function (...) { ... }
    if (next && next.type === 'punct' && next.value === '=') {
      const slice = tokens.slice(i + 2, i + 60)
      const body = extractFunctionBody(slice)
      if (body) return body
    }
  }
  return null
}

/**
 * 判断 body 里的 next 调用是否把结果交回宿主。
 * @param {Array<object>} body - 函数体 token。
 * @param {number} at - next 标识符的下标。
 * @returns {boolean} 是否 return / await / 简写返回。
 */
function isReturnedCall(body, at) {
  let j = at - 1
  while (j >= 0 && body[j].type === 'punct' && body[j].value === '(') j--
  if (j < 0) return false
  const t = body[j]
  if (t.type === 'name' && (t.value === 'return' || t.value === 'await' || t.value === 'yield')) return true
  if (t.type === 'punct' && t.value === '=>') return true
  return false
}

/**
 * 判断 next() 的结果是不是先存进变量、之后又被 return 出去。
 * @param {Array<object>} body - 函数体 token。
 * @param {number} at - next 标识符的下标。
 * @returns {boolean} 是否间接返回。
 */
function isReturnedViaVariable(body, at) {
  const prev = body[at - 1]
  const prev2 = body[at - 2]
  if (!prev || prev.type !== 'name') return false
  if (!prev2 || prev2.type !== 'punct' || prev2.value !== '=') return false
  for (let j = 0; j < body.length; j++) {
    const t = body[j]
    if (t.type !== 'name' || t.value !== 'return') continue
    const after = body[j + 1]
    if (after && after.type === 'name' && after.value === prev.value) return true
  }
  return false
}

/**
 * 分析监听器函数体里对 next 的使用。
 * @param {Array<object>} body - 函数体 token。
 * @returns {{called: boolean, returned: boolean, calls: number}} 使用情况。
 */
export function analyzeNextUsage(body) {
  const calls = []
  for (let i = 0; i < body.length; i++) {
    const t = body[i]
    if (t.type !== 'name' || t.value !== 'next') continue
    const after = body[i + 1]
    if (!after || after.type !== 'punct' || after.value !== '(') continue
    calls.push(i)
  }
  const returned = calls.some((at) => isReturnedCall(body, at) || isReturnedViaVariable(body, at))
  return { called: calls.length > 0, returned, calls: calls.length }
}

/* ------------------------------------------------------------------ *
 * 事件订阅提取
 * ------------------------------------------------------------------ */

/**
 * 找出源码里所有 `<对象>.on(<事件名>, …)` 订阅。
 *
 * 事件名必须能静态确定：单引号、双引号、无表达式的模板字符串都算；
 * 含 `${…}` 的模板、变量、拼接表达式都算"动态"，一律判违规。
 * @param {string} source - 源码。
 * @returns {Array<object>} 订阅列表。
 */
export function extractSubscriptions(source) {
  const tokens = tokenize(source)
  const subscriptions = []

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.type !== 'name') continue
    const dot = tokens[i + 1]
    const on = tokens[i + 2]
    const open = tokens[i + 3]
    if (!dot || dot.type !== 'punct' || dot.value !== '.') continue
    if (!on || on.type !== 'name' || on.value !== 'on') continue
    if (!open || open.type !== 'punct' || open.value !== '(') continue

    const close = matchBracket(tokens, i + 3)
    const args = splitArguments(tokens, i + 3, close)
    const arg = args[0]?.[0]

    const entry = {
      object: t.value,
      event: null,
      dynamic: false,
      reason: null,
      line: source.slice(0, t.start).split('\n').length,
      listener: null,
    }

    if (arg === undefined) {
      entry.dynamic = true
      entry.reason = '没有传事件名'
    } else if (arg.type === 'string') {
      entry.event = arg.value
    } else if (arg.type === 'template') {
      if (arg.hasExpr) {
        entry.dynamic = true
        entry.reason = '事件名是含表达式的模板字符串，静态不可判定'
      } else {
        entry.event = arg.value
      }
    } else {
      entry.dynamic = true
      entry.reason = '事件名不是字面量（' + arg.type + '）'
    }

    // 实参 0 是事件名，实参 1 才是监听器。
    entry.listener = resolveListener(args[1] ?? [], tokens)
    subscriptions.push(entry)
  }

  return subscriptions
}

/**
 * 解析监听器实参，拿到它的函数体 token。
 * @param {Array<object>} argTokens - 监听器实参 token。
 * @param {Array<object>} allTokens - 全量 token（解析具名函数时用）。
 * @returns {{body: Array<object>|null, form: string}} 解析结果。
 */
function resolveListener(argTokens, allTokens) {
  const inline = extractFunctionBody(argTokens)
  if (inline !== null) return { body: inline, form: 'inline' }
  if (argTokens.length === 1 && argTokens[0].type === 'name') {
    const body = resolveNamedFunction(allTokens, argTokens[0].value)
    if (body !== null) return { body, form: 'reference:' + argTokens[0].value }
    return { body: null, form: 'unresolved:' + argTokens[0].value }
  }
  return { body: null, form: 'unknown' }
}

/**
 * 审计源码里的事件订阅：是否都已分级、waterfall 是否真的调用 next()。
 * @param {string} source - 源码。
 * @param {Record<string, string>} [knownModes] - 事件分级表。
 * @returns {{subscriptions: Array<object>, problems: Array<object>}} 审计结果。
 */
export function auditEventSubscriptions(source, knownModes = KNOWN_EVENT_MODES) {
  const subscriptions = extractSubscriptions(source)
  const problems = []

  for (const sub of subscriptions) {
    if (sub.dynamic) {
      problems.push({
        type: 'dynamic-event-name',
        event: null,
        message: `第 ${sub.line} 行：${sub.object}.on() 的事件名不是静态字面量（${sub.reason}）`,
      })
      continue
    }
    const mode = knownModes[sub.event]
    if (mode === undefined) {
      problems.push({
        type: 'unclassified',
        event: sub.event,
        message: `第 ${sub.line} 行：订阅了未分级的事件「${sub.event}」（先确认它是 emit 还是 waterfall，再补进 KNOWN_EVENT_MODES）`,
      })
      continue
    }
    if (mode !== 'waterfall') continue

    if (sub.listener.body === null) {
      problems.push({
        type: 'waterfall-unresolved',
        event: sub.event,
        message: `第 ${sub.line} 行：「${sub.event}」是 waterfall，但解析不出监听器函数体（${sub.listener.form}），无法确认它调用了 next()`,
      })
      continue
    }
    const usage = analyzeNextUsage(sub.listener.body)
    if (!usage.called) {
      problems.push({
        type: 'waterfall-no-next',
        event: sub.event,
        message: `第 ${sub.line} 行：「${sub.event}」是 waterfall，监听器里没有真正调用 next()`,
      })
      continue
    }
    if (!usage.returned) {
      problems.push({
        type: 'waterfall-next-not-returned',
        event: sub.event,
        message: `第 ${sub.line} 行：「${sub.event}」是 waterfall，next() 的结果没有 return / await 交回宿主`,
      })
    }
  }

  return { subscriptions, problems }
}

/* ------------------------------------------------------------------ *
 * 运行时行为（黑盒）
 * ------------------------------------------------------------------ */

/** 收集 `ctx.on` 注册的监听器，其它宿主服务一律给最小替身。 */
function createFakeHost() {
  const listeners = new Map()
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    // apply 只在 connection 就绪后才注册路由与采样循环；单测不跑那条分支。
    inject() {},
    on(event, handler, options) {
      listeners.set(event, { handler, options })
      return () => listeners.delete(event)
    },
    effect() {},
    get() { return undefined },
  }
  return { ctx, listeners }
}

defineTest('预执行监听器把决策继续传给下游', () => {
  const { ctx, listeners } = createFakeHost()
  apply(ctx, { enabled: true })

  const middleware = listeners.get('tools/pre-execute')
  assert.ok(middleware, '必须注册 tools/pre-execute 监听器')

  const decision = { kind: 'allow' }
  let calls = 0
  const returned = middleware.handler({ name: 'run_code' }, () => {
    calls += 1
    return decision
  })

  assert.equal(calls, 1, '必须调用一次 next()')
  assert.equal(returned, decision, '必须把下游的决策原样返回')
})

defineTest('结果观察器保持 emit 语义', () => {
  const { ctx, listeners } = createFakeHost()
  apply(ctx, { enabled: true })

  const observer = listeners.get('tools/result')
  assert.ok(observer, '必须注册 tools/result 观察者')
  assert.equal(observer.handler({ name: 'run_code' }, { isError: false }), undefined)
})

defineTest('分级表与契约 §2.6 一致', () => {
  // §2.6 列的事件：只有 tools/pre-execute 是 waterfall，其余全是 emit。
  assert.equal(KNOWN_EVENT_MODES['tools/pre-execute'], 'waterfall')
  for (const event of ['tools/result', 'agent/status', 'agent/disposed', 'session/disposed']) {
    assert.equal(KNOWN_EVENT_MODES[event], 'emit', event + ' 应当是 emit')
  }
})

defineTest('每个订阅到的事件都已被分级', async () => {
  const source = await readFile(join(ROOT, 'index.js'), 'utf8')
  const { subscriptions, problems } = auditEventSubscriptions(source)

  assert.ok(subscriptions.length > 0, 'index.js 里应当至少有一个 ctx.on 订阅')

  const unclassified = problems.filter((problem) => problem.type === 'unclassified')
  assert.deepEqual(
    unclassified.map((problem) => problem.event),
    [],
    '订阅了未分级的事件：' + unclassified.map((problem) => problem.message).join('; '),
  )

  const dynamic = problems.filter((problem) => problem.type === 'dynamic-event-name')
  assert.deepEqual(
    dynamic.map((problem) => problem.message),
    [],
    '事件名必须能静态判定：' + dynamic.map((problem) => problem.message).join('; '),
  )
})

defineTest('waterfall 监听器真的调用了 next()', async () => {
  const source = await readFile(join(ROOT, 'index.js'), 'utf8')
  const { problems } = auditEventSubscriptions(source)

  const violations = problems.filter((problem) => problem.type.startsWith('waterfall-'))
  assert.deepEqual(
    violations.map((problem) => problem.message),
    [],
    'waterfall 监听器必须真的调用 next() 并把结果交回宿主',
  )
})

/* ------------------------------------------------------------------ *
 * 变异测试：证明护栏本身能被证伪
 * ------------------------------------------------------------------ */

/**
 * 读一份真实的 index.js 源码。
 * @returns {Promise<string>} 源码。
 */
async function readIndexSource() {
  return readFile(join(ROOT, 'index.js'), 'utf8')
}

defineTest('变异：双引号事件名照样能被提取', async () => {
  const source = await readIndexSource()
  const mutated = source.replace("ctx.on('tools/result'", 'ctx.on("tools/result"')
  assert.notEqual(mutated, source, '变异没有生效：index.js 里找不到 ctx.on(\'tools/result\'')

  const { subscriptions } = auditEventSubscriptions(mutated)
  const events = subscriptions.map((sub) => sub.event)
  assert.ok(events.includes('tools/result'), '双引号写的事件名必须照样被提取')
})

defineTest('变异：反引号事件名照样能被提取', async () => {
  const source = await readIndexSource()
  const mutated = source.replace("ctx.on('tools/result'", 'ctx.on(`tools/result`')
  assert.notEqual(mutated, source, '变异没有生效')

  const { subscriptions } = auditEventSubscriptions(mutated)
  const events = subscriptions.map((sub) => sub.event)
  assert.ok(events.includes('tools/result'), '反引号写的事件名必须照样被提取')
})

defineTest('变异：用双引号订阅一个没分级的事件会被抓住', async () => {
  const source = await readIndexSource()
  const mutated = source + '\nctx.on("evil/event", () => {})\n'
  const { problems } = auditEventSubscriptions(mutated)

  const unclassified = problems.filter((problem) => problem.type === 'unclassified')
  assert.deepEqual(unclassified.map((problem) => problem.event), ['evil/event'])
})

defineTest('变异：用反引号订阅一个没分级的事件会被抓住', async () => {
  const source = await readIndexSource()
  const mutated = source + '\nctx.on(`evil/event`, () => {})\n'
  const { problems } = auditEventSubscriptions(mutated)

  const unclassified = problems.filter((problem) => problem.type === 'unclassified')
  assert.deepEqual(unclassified.map((problem) => problem.event), ['evil/event'])
})

defineTest('变异：注释里的 next() 不算数', async () => {
  const source = await readIndexSource()
  const mutated = source.replace('return next()', '// next() 只是注释')
  assert.notEqual(mutated, source, '变异没有生效')

  const { problems } = auditEventSubscriptions(mutated)
  const violations = problems.filter((problem) => problem.type.startsWith('waterfall-'))
  assert.ok(violations.length > 0, '注释里的 next() 必须被判为"没有调用 next()"')
})

defineTest('变异：字符串里的 next() 不算数', async () => {
  const source = await readIndexSource()
  const mutated = source.replace('return next()', 'const hint = "next("')
  assert.notEqual(mutated, source, '变异没有生效')

  const { problems } = auditEventSubscriptions(mutated)
  const violations = problems.filter((problem) => problem.type.startsWith('waterfall-'))
  assert.ok(violations.length > 0, '字符串里的 next() 必须被判为"没有调用 next()"')
})

defineTest('变异：调用了 next() 但没有交回结果会被抓住', async () => {
  const source = await readIndexSource()
  const mutated = source.replace('return next()', 'next()')
  assert.notEqual(mutated, source, '变异没有生效')

  const { problems } = auditEventSubscriptions(mutated)
  const violations = problems.filter((problem) => problem.type.startsWith('waterfall-'))
  assert.ok(violations.length > 0, 'next() 没有 return / await 交回宿主必须被抓出来')
})

defineTest('变异：漏掉 return next() 会被运行时用例抓住', () => {
  // 静态检查抓不住"调用了但语义反了"的情况，所以运行时用例必须还在。
  const { ctx, listeners } = createFakeHost()
  apply(ctx, { enabled: true })
  const middleware = listeners.get('tools/pre-execute')
  assert.ok(middleware, '必须注册 tools/pre-execute 监听器')

  let calls = 0
  const returned = middleware.handler({ name: 'run_code' }, () => {
    calls += 1
    return { kind: 'allow' }
  })
  assert.equal(calls, 1)
  assert.equal(returned.kind, 'allow')
})
