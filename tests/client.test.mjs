/**
 * 客户端 bundle 的结构单测：模块 id、slot 注册、词典、纯函数行为、渲染冒烟。
 *
 * 注意：这里只验证「bundle 能加载、注册了什么、渲染分支不炸」，**不代表**真实页面渲染已验收；
 * UI 渲染需要在真实浏览器里点验（见 README 的验证章节）。
 *
 * 字段口径按 docs/CONTRACT.md v2：mechanism.kind 分流文案，
 * trim.rssDeltaBytes / totalRssDeltaBytes / lastRssDeltaBytes / lastNativeReleasedBytes。
 *
 * 假宿主环境在 tests/helpers/client-harness.mjs。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Script } from 'node:vm'
import { buildClient } from '../scripts/build-client.mjs'
import {
  STATS_FIXTURE, assertHas, createCtx, findAll, flush, loadClient, noticeText,
  renderSection, renderTree, routesFor, textOf,
} from './helpers/client-harness.mjs'

test('模块 id 与 apply 注册符合契约', async () => {
  const { loaded, harness } = await loadClient()
  assert.equal(loaded.id, 'dsh-lowmem')
  assert.equal(typeof loaded.factory, 'function')
  assert.doesNotThrow(() => loaded.factory(() => harness.react))
  const module = loaded.factory(() => harness.react)
  assert.deepEqual([...module.inject], ['slots', 'locale'])
  const { ctx, registrations, dictionaries } = createCtx()
  module.apply(ctx)
  assert.equal(registrations.length, 1)
  const options = registrations[0].options
  assert.equal(options.name, 'settings.section')
  assert.equal(options.id, 'dsh-lowmem')
  assert.equal(options.locale, 'lowmem')
  assert.equal(typeof options.order, 'number')
  assert.equal(typeof options.label, 'function')
  assert.equal(options.label(), '内存回收')
  assert.equal(typeof registrations[0].component, 'function')
  assert.equal(dictionaries.length, 1)
  assert.equal(dictionaries[0][0], 'lowmem')
  assert.ok(dictionaries[0][1].zh['settings.title'])
  assert.ok(dictionaries[0][1].en['settings.title'])
})

test('纯函数：格式化、错误文本、配置换算与下界夹取', async () => {
  const source = await buildClient({ compact: false })
  const patched = source.replace(
    "    return {\n      inject: ['slots', 'locale'],",
    "    return {\n      checks: { TEXT, TEXT_EN, formatBytes, formatDuration, formatTime, errorText, configToForm, formToPayload, looksLikeConfig, extractConfig, reasonText, mechanismKind, reclaimKeys, clampToMin, CONFIG_MIN },\n      inject: ['slots', 'locale'],",
  )
  assert.notEqual(patched, source, 'client.js 的返回对象形状变了，测试需要同步')
  const { loaded, harness } = await loadClient({ source: patched })
  const checks = loaded.factory(() => harness.react).checks
  assert.equal(checks.formatBytes(0), '0 B'); assert.equal(checks.formatBytes(512), '512 B')
  assert.equal(checks.formatBytes(2048), '2.0 KB'); assert.equal(checks.formatBytes(1610612736), '1.5 GB')
  assert.equal(checks.formatBytes(Number.NaN), '0 B'); assert.equal(checks.formatDuration(19), '19 ms')
  assert.equal(checks.formatDuration(1500), '1.5 s'); assert.equal(checks.formatDuration(0), '0 ms')
  assert.equal(checks.formatTime(0), '—')
  assert.equal(checks.errorText({ message: '失败', detail: '原因' }, '兜底'), '失败（原因）')
  assert.equal(checks.errorText(null, '兜底'), '兜底')
  assert.equal(checks.looksLikeConfig({ ok: true }), false)
  assert.equal(checks.looksLikeConfig(STATS_FIXTURE.config), true)
  // GET /config 两种形状都要认：直接返回 config，或包一层 { ok, config }
  assert.equal(checks.extractConfig(STATS_FIXTURE.config), STATS_FIXTURE.config)
  assert.equal(checks.extractConfig({ ok: true, config: STATS_FIXTURE.config }).thresholdBytes, 268435456)
  assert.equal(checks.extractConfig({ ok: true }), null)
  assert.equal(checks.reasonText('hard-cap', key => key), 'reason.hardCap')
  assert.equal(checks.reasonText('???', key => key), 'reason.unknown')
  // 机制类型分流
  assert.equal(checks.mechanismKind({ kind: 'reclaim' }), 'reclaim')
  assert.equal(checks.mechanismKind({ kind: 'swap-out' }), 'swap-out')
  assert.equal(checks.mechanismKind({}), null); assert.equal(checks.mechanismKind(null), null)
  assert.equal(checks.reclaimKeys({ kind: 'reclaim' }).word, 'word.released')
  assert.equal(checks.reclaimKeys({ kind: 'swap-out' }).word, 'word.swapped')
  assert.equal(checks.reclaimKeys({ kind: 'swap-out' }).swap, true)
  assert.equal(checks.reclaimKeys({}).word, 'word.rssDelta')
  assert.equal(checks.reclaimKeys(null).word, 'word.rssDelta')
  const form = checks.configToForm(STATS_FIXTURE.config)
  assert.equal(form.enabled, true); assert.equal(form.thresholdMb, '256')
  assert.equal(form.hardCapMb, '3072'); assert.equal(form.minIntervalSec, '60')
  assert.equal(form.idleIntervalSec, '300'); assert.equal(form.sampleIntervalSec, '15')
  const payload = checks.formToPayload(form, STATS_FIXTURE.config)
  assert.deepEqual(JSON.parse(JSON.stringify(payload)), {
    enabled: true,
    thresholdBytes: 268435456,
    minIntervalMs: 60000,
    idleIntervalMs: 300000,
    hardCapBytes: 3221225472,
    sampleIntervalMs: 15000,
  })
  // 填错时沿用旧值，不会把配置写成 NaN
  assert.equal(checks.formToPayload({ ...form, thresholdMb: '' }, STATS_FIXTURE.config).thresholdBytes, 268435456)
  // 小于下界的值被夹到下界（契约 §2.4）
  const tiny = checks.formToPayload({ ...form, thresholdMb: '1', hardCapMb: '1', minIntervalSec: '1', idleIntervalSec: '1', sampleIntervalSec: '0' }, STATS_FIXTURE.config)
  assert.equal(tiny.thresholdBytes, 16 * 1024 * 1024); assert.equal(tiny.hardCapBytes, 256 * 1024 * 1024)
  assert.equal(tiny.minIntervalMs, 5000); assert.equal(tiny.idleIntervalMs, 30000)
  assert.equal(tiny.sampleIntervalMs, 1000)
  assert.equal(checks.clampToMin(1, 100), 100); assert.equal(checks.clampToMin(500, 100), 500)
  // 下界常量本身要对
  const bounds = { thresholdBytes: 16 * 1024 * 1024, hardCapBytes: 256 * 1024 * 1024, minIntervalMs: 5000, idleIntervalMs: 30000, sampleIntervalMs: 1000 }
  for (const [key, value] of Object.entries(bounds)) assert.equal(checks.CONFIG_MIN[key], value, '下界不对：' + key)
  // 中英文词典键一致
  assert.deepEqual(Object.keys(checks.TEXT).sort(), Object.keys(checks.TEXT_EN).sort())
  // v1 的旧字段名不该再出现在词典里
  for (const key of ['field.totalReclaimed', 'field.lastReclaimed', 'trimDone']) assert.ok(!(key in checks.TEXT), '旧词条还在：' + key)
  // 三种口径的文案都要有中英文
  for (const key of ['word.released', 'word.swapped', 'word.rssDelta', 'trim.released', 'trim.swapped', 'trim.rssDelta', 'trim.swapHint', 'trim.nativeAmount']) {
    assert.ok(checks.TEXT[key], '缺中文词条：' + key)
    assert.ok(checks.TEXT_EN[key], '缺英文词条：' + key)
  }
})

test('渲染冒烟：加载 → 正常 → 立即回收 → 保存配置', async () => {
  const routes = routesFor(STATS_FIXTURE)
  const { loaded, harness, calls, timers } = await loadClient({ routes })
  const module = loaded.factory(() => harness.react)
  const { ctx, registrations } = createCtx()
  module.apply(ctx)
  const component = registrations[0].component
  // 1. 首屏：加载中
  assert.match(textOf(renderTree(harness, component, {})), /正在读取内存状态/)
  // 2. 跑 effect：拉取 stats + config
  const cleanup = harness.effects[0]()
  await flush()
  const tree = renderTree(harness, component, {})
  const text = textOf(tree)
  assertHas(text, [
    /malloc_trim/, /1\.5 GB/, /可用/, /累计回收量/, /触发阈值/, /峰值 RSS/, /堆常驻/,
    /活跃状态/, /活跃 agent 数/, /活跃后台任务数/, /触发原因分布/, /上次原生释放量/,
    /分配器建议/, /MALLOC_MMAP_THRESHOLD_=131072/, /峰值 RSS -80%/, /可回收碎片 -98%/, /已释放/,
  ])
  assert.doesNotMatch(text, /已换出/)
  const numberInputs = findAll(tree, node => node.type === 'input' && node.props.type === 'number')
  assert.deepEqual(numberInputs.map(node => node.props.value), ['256', '3072', '60', '300', '15'])
  // 输入框带单位与下界
  assert.deepEqual(numberInputs.map(node => node.props.min), ['16', '256', '5', '30', '1'])
  assert.ok(timers.length === 1, '应该只起一个轮询定时器')
  assert.equal(timers[0].ms, 5000, '轮询间隔应该是 5 秒')
  // 3. 点「立即回收」
  const trimButton = findAll(tree, node => node.type === 'button' && textOf(node).includes('立即回收'))
  assert.equal(trimButton.length, 1)
  await trimButton[0].props.onClick()
  await flush()
  const trimCall = calls.find(call => call.method === 'POST' && call.url === '/api/dsh-lowmem/trim')
  assert.ok(trimCall, '没有发出回收请求')
  assert.equal(trimCall.body, JSON.stringify({ force: true }))
  assert.match(noticeText(harness, component), /已释放 .*耗时/)
  // 4. 改阈值后保存，提交时换算回字节
  const threshold = findAll(renderTree(harness, component, {}), node => node.type === 'input' && node.props.value === '256')
  assert.equal(threshold.length, 1)
  threshold[0].props.onChange({ target: { value: '512' } })
  const saveButton = findAll(renderTree(harness, component, {}), node => node.type === 'button' && textOf(node).includes('保存'))
  assert.equal(saveButton.length, 1)
  await saveButton[0].props.onClick()
  await flush()
  const putCall = calls.find(call => call.method === 'PUT' && call.url === '/api/dsh-lowmem/config')
  assert.ok(putCall, '没有发出保存请求')
  const sent = JSON.parse(putCall.body)
  assert.equal(sent.enabled, true); assert.equal(sent.thresholdBytes, 536870912)
  assert.equal(sent.minIntervalMs, 60000); assert.equal(sent.hardCapBytes, 3221225472)
  assert.equal(sent.sampleIntervalMs, 15000)
  // 5. 卸载时定时器要停掉
  cleanup()
  assert.equal(timers[0].cleared, true, '组件卸载后必须清掉轮询定时器')
})

test('回收量文案按机制类型分流：reclaim / swap-out / 未知', async () => {
  // reclaim：真的还给操作系统 → 「已释放」
  const reclaimed = textOf((await renderSection(routesFor(STATS_FIXTURE))).tree)
  assert.match(reclaimed, /已释放/); assert.doesNotMatch(reclaimed, /已换出/)
  // swap-out：只是换出到页面文件 → 「已换出」+ 变慢提示
  const swapStats = structuredClone(STATS_FIXTURE)
  swapStats.mechanism = { available: true, name: 'EmptyWorkingSet', kind: 'swap-out', detail: 'psapi EmptyWorkingSet' }
  const swapText = textOf((await renderSection(routesFor(swapStats))).tree)
  assert.match(swapText, /已换出/); assert.match(swapText, /后续访问这些页会变慢/)
  assert.match(swapText, /页缺失 → 软缺页 → 磁盘读/); assert.doesNotMatch(swapText, /已释放/)
  // 机制类型缺失：退回中性说法，不暗示「释放给了操作系统」
  const unknownStats = structuredClone(STATS_FIXTURE)
  delete unknownStats.mechanism.kind
  const unknownText = textOf((await renderSection(routesFor(unknownStats))).tree)
  assert.match(unknownText, /RSS 变化/); assert.doesNotMatch(unknownText, /已释放/)
  assert.doesNotMatch(unknownText, /已换出/)
  // 手动回收后的提示同样分流
  const swapRoutes = routesFor(swapStats)
  swapRoutes['/api/dsh-lowmem/trim'] = {
    ok: true, rssDeltaBytes: 168000000, nativeReleasedBytes: null, durationMs: 19,
    mechanism: { available: true, name: 'EmptyWorkingSet', kind: 'swap-out', detail: 'psapi EmptyWorkingSet' },
  }
  const manual = await renderSection(swapRoutes)
  await findAll(manual.tree, node => node.type === 'button' && textOf(node).includes('立即回收'))[0].props.onClick()
  await flush()
  const notice = noticeText(manual.harness, manual.component)
  assert.match(notice, /已换出 .*耗时/); assert.match(notice, /后续访问这些页会变慢/)
})

test('手动回收提示：原生报了字节数时一并显示', async () => {
  const routes = routesFor(STATS_FIXTURE)
  routes['/api/dsh-lowmem/trim'] = {
    ok: true, rssDeltaBytes: 168000000, nativeReleasedBytes: 150000000, durationMs: 19,
    mechanism: { available: true, name: 'malloc_zone_pressure_relief', kind: 'reclaim', detail: 'macOS malloc_zone_pressure_relief' },
  }
  const native = await renderSection(routes)
  await findAll(native.tree, node => node.type === 'button' && textOf(node).includes('立即回收'))[0].props.onClick()
  await flush()
  const notice = noticeText(native.harness, native.component)
  assert.match(notice, /已释放/); assert.match(notice, /原生释放/)
  // 原生没报字节数时不硬凑一个数出来
  const plain = await renderSection(routesFor(STATS_FIXTURE))
  await findAll(plain.tree, node => node.type === 'button' && textOf(node).includes('立即回收'))[0].props.onClick()
  await flush()
  assert.doesNotMatch(noticeText(plain.harness, plain.component), /原生释放/)
})

test('配置下界：小于下界的输入被夹到下界，不报错', async () => {
  const { harness, component, calls } = await renderSection(routesFor(STATS_FIXTURE))
  const inputs = findAll(renderTree(harness, component, {}), node => node.type === 'input' && node.props.type === 'number')
  const byMin = new Map(inputs.map(node => [String(node.props.min), node]))
  assert.deepEqual([...byMin.keys()].sort(), ['1', '16', '256', '30', '5'])
  byMin.get('16').props.onChange({ target: { value: '1' } })
  byMin.get('256').props.onChange({ target: { value: '0' } })
  byMin.get('5').props.onChange({ target: { value: '1' } })
  byMin.get('30').props.onChange({ target: { value: '2' } })
  byMin.get('1').props.onChange({ target: { value: '0' } })
  const saveButton = findAll(renderTree(harness, component, {}), node => node.type === 'button' && textOf(node).includes('保存'))
  await saveButton[0].props.onClick()
  await flush()
  const putCall = calls.find(call => call.method === 'PUT' && call.url === '/api/dsh-lowmem/config')
  assert.ok(putCall, '没有发出保存请求')
  const sent = JSON.parse(putCall.body)
  assert.equal(sent.thresholdBytes, 16 * 1024 * 1024); assert.equal(sent.hardCapBytes, 256 * 1024 * 1024)
  assert.equal(sent.minIntervalMs, 5000); assert.equal(sent.idleIntervalMs, 30000)
  assert.equal(sent.sampleIntervalMs, 1000)
  // 保存成功后表单要显示夹取后的值
  const saved = findAll(renderTree(harness, component, {}), node => node.type === 'input' && node.props.type === 'number')
  assert.deepEqual(saved.map(node => node.props.value), ['16', '256', '5', '30', '1'])
})

test('分配器建议：未固定 mmap 阈值时给醒目提示，已固定时显示已配置', async () => {
  const text = textOf((await renderSection(routesFor(STATS_FIXTURE))).tree)
  assertHas(text, [/建议以 MALLOC_MMAP_THRESHOLD_=131072 启动宿主/, /峰值 RSS -80%/, /可回收碎片 -98%/, /MALLOC_MMAP_THRESHOLD_=131072 dsh --profile web/])
  const pinnedStats = structuredClone(STATS_FIXTURE)
  pinnedStats.allocator = { mmapThresholdPinned: true, recommendedEnv: 'MALLOC_MMAP_THRESHOLD_=131072', recommendation: '' }
  const pinnedText = textOf((await renderSection(routesFor(pinnedStats))).tree)
  assert.match(pinnedText, /已按推荐配置启动/)
  assert.doesNotMatch(pinnedText, /建议以 MALLOC_MMAP_THRESHOLD_=131072 启动宿主/)
})

test('接口连不上或回收失败时显示可读提示，不抛异常', async () => {
  const broken = await loadClient({
    routes: {
      '/api/dsh-lowmem/stats': () => { throw new Error('boom') },
      '/api/dsh-lowmem/config': () => { throw new Error('boom') },
    },
  })
  const module = broken.loaded.factory(() => broken.harness.react)
  const { ctx, registrations } = createCtx()
  module.apply(ctx)
  const component = registrations[0].component
  renderTree(broken.harness, component, {})
  broken.harness.effects[0]()
  await flush()
  assertHas(textOf(renderTree(broken.harness, component, {})), [/读取内存状态失败/, /boom/, /重试/])
  // 回收失败时给出可读原因（取机制说明）
  const routes = routesFor(STATS_FIXTURE)
  routes['/api/dsh-lowmem/trim'] = { ok: false, rssDeltaBytes: 0, nativeReleasedBytes: null, durationMs: 0, mechanism: { available: false, name: null, kind: null, detail: '本平台暂不支持原生回收' } }
  const failed = await renderSection(routes)
  await findAll(failed.tree, node => node.type === 'button' && textOf(node).includes('立即回收'))[0].props.onClick()
  await flush()
  assert.match(textOf(renderTree(failed.harness, failed.component, {})), /本平台暂不支持原生回收/)
})

test('提交的 client.js 与 src/client/*.js 构建结果一致，且不越红线', async () => {
  const committed = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  assert.equal(committed, await buildClient(), 'client.js 未同步：运行 node scripts/build-client.mjs')
  assert.ok(committed.split('\n').length < 1000, '生成的 client.js 也要控制在 1000 行内')
  assert.doesNotThrow(() => new Script(committed), 'client.js 不是合法脚本')
  assert.ok(!/document\.body/.test(committed), '不能往 document.body 追加 DOM')
  assert.ok(!/document\.createElement/.test(committed), '不能在组件外写 DOM')
  assert.ok(!/@deepseek-ai/.test(committed), '不能 require @deepseek-ai/dsh-client-*')
  assert.ok(!/\biframe\b/.test(committed), '不能 iframe')
  const literals = [...committed.matchAll(/(?:color|background|border|boxShadow)\s*:\s*'([^']*)'/g)].map(match => match[1])
  for (const value of literals) {
    const allowed = value === 'transparent' || value.includes('transparent')
    assert.ok(allowed || value.includes('var(--dsw-alias-'), `样式写死了颜色：${value}`)
  }
})

test('locale 文件只含 meta', async () => {
  for (const name of ['en', 'zh']) {
    const parsed = JSON.parse(await readFile(new URL(`../locale/${name}.json`, import.meta.url), 'utf8'))
    assert.deepEqual(Object.keys(parsed), ['meta'])
    assert.deepEqual(Object.keys(parsed.meta).sort(), ['description', 'title'])
    assert.ok(parsed.meta.title.length > 0); assert.ok(parsed.meta.description.length > 0)
  }
})
