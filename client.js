/**
* 本文件由 scripts/build-client.mjs 从 src/client/*.js 自动生成，请勿直接修改。
* 修改请改 src/client/ 下的源码，然后运行：node scripts/build-client.mjs
*/
window.__ModuleLoader__.load({ id: 'dsh-lowmem', factory(require) { const React = require('react')
const h = React.createElement
const { useEffect, useRef, useState } = React
const NS = 'lowmem'
const API = '/api/dsh-lowmem'
const POLL_INTERVAL_MS = 5000
const BYTES_PER_MB = 1048576
const MS_PER_SECOND = 1000
const CONFIG_KEYS = ['enabled', 'thresholdBytes', 'minIntervalMs', 'idleIntervalMs', 'hardCapBytes', 'sampleIntervalMs']
/** 中文词典。 */
const TEXT = { 'settings.title': '内存回收', 'settings.description': '查看进程内存占用，手动或按策略触发原生内存回收。', 'section.memory': '当前内存', 'section.mechanism': '原生回收机制', 'section.trim': '累计统计', 'section.config': '回收策略',
'field.rss': '常驻内存 RSS', 'field.heapUsed': 'V8 堆已用', 'field.heapTotal': 'V8 堆总量', 'field.external': '外部内存', 'field.arrayBuffer': 'ArrayBuffer', 'field.uptime': '运行时长', 'field.pid': '进程 PID', 'field.platform': '运行平台',
'field.count': '回收次数', 'field.totalReclaimed': '累计回收量', 'field.lastReclaimed': '上次释放', 'field.lastDuration': '上次耗时', 'field.lastAt': '上次时间', 'field.lastReason': '触发原因', 'field.lastError': '上次错误', 'field.mechanism': '机制',
'field.enabled': '启用自动回收', 'field.threshold': '触发阈值', 'field.minInterval': '最小回收间隔', 'field.idleInterval': '空闲兜底间隔', 'field.hardCap': '硬上限', 'mechanism.available': '可用', 'mechanism.unavailable': '不可用',
'mechanism.unknown': '未知机制', 'reason.threshold': '达到阈值', 'reason.idle': '空闲兜底', 'reason.hardCap': '超过硬上限', 'reason.disabled': '策略已禁用', 'reason.belowThreshold': '未达阈值', 'reason.manual': '手动触发', 'reason.unknown': '未知',
'button.trim': '立即回收', 'button.trimming': '正在回收…', 'button.refresh': '刷新', 'button.retry': '重试', 'button.save': '保存', 'button.saving': '保存中…', 'button.discard': '放弃修改', 'loading': '正在读取内存状态…',
'loadFailed': '读取内存状态失败：{detail}', 'pollFailed': '刷新失败（仍显示上次数据）：{detail}', 'trimDone': '已释放 {size}，耗时 {duration}', 'trimFailed': '回收失败：{detail}', 'configSaved': '配置已保存', 'configFailed': '保存配置失败：{detail}',
'configUnavailable': '配置接口不可用，暂时无法修改策略。', 'updatedAt': '更新于 {time}', 'unit.mb': 'MB', 'unit.second': '秒', 'common.dash': '—', 'error.boundary': '这个分区渲染出错了，其它功能不受影响。', }
/** 英文词典（键与中文完全一致）。 */
const TEXT_EN = { 'settings.title': 'Memory trim', 'settings.description': 'Inspect process memory and trigger native reclamation on demand or by policy.', 'section.memory': 'Current memory',
'section.mechanism': 'Native reclamation', 'section.trim': 'Cumulative stats', 'section.config': 'Trim policy', 'field.rss': 'Resident memory (RSS)', 'field.heapUsed': 'V8 heap used', 'field.heapTotal': 'V8 heap total',
'field.external': 'External memory', 'field.arrayBuffer': 'ArrayBuffer', 'field.uptime': 'Uptime', 'field.pid': 'Process PID', 'field.platform': 'Platform', 'field.count': 'Trim count',
'field.totalReclaimed': 'Total reclaimed', 'field.lastReclaimed': 'Last reclaimed', 'field.lastDuration': 'Last duration', 'field.lastAt': 'Last trim', 'field.lastReason': 'Last reason', 'field.lastError': 'Last error',
'field.mechanism': 'Mechanism', 'field.enabled': 'Enable automatic trim', 'field.threshold': 'Growth threshold', 'field.minInterval': 'Minimum interval', 'field.idleInterval': 'Idle fallback interval',
'field.hardCap': 'Hard cap', 'mechanism.available': 'available', 'mechanism.unavailable': 'unavailable', 'mechanism.unknown': 'unknown mechanism', 'reason.threshold': 'threshold reached', 'reason.idle': 'idle fallback',
'reason.hardCap': 'hard cap exceeded', 'reason.disabled': 'policy disabled', 'reason.belowThreshold': 'below threshold', 'reason.manual': 'manual', 'reason.unknown': 'unknown', 'button.trim': 'Trim now',
'button.trimming': 'Trimming…', 'button.refresh': 'Refresh', 'button.retry': 'Retry', 'button.save': 'Save', 'button.saving': 'Saving…', 'button.discard': 'Discard changes', 'loading': 'Loading memory status…',
'loadFailed': 'Failed to load memory status: {detail}', 'pollFailed': 'Refresh failed (showing the previous data): {detail}', 'trimDone': 'Reclaimed {size} in {duration}', 'trimFailed': 'Trim failed: {detail}',
'configSaved': 'Configuration saved', 'configFailed': 'Failed to save configuration: {detail}', 'configUnavailable': 'The configuration API is unavailable; the policy cannot be changed for now.',
'updatedAt': 'Updated at {time}', 'unit.mb': 'MB', 'unit.second': 'seconds', 'common.dash': '—', 'error.boundary': 'This section failed to render; everything else keeps working.', }
/** 把 {name} 占位符替换掉。 */
function interpolate(template, params) { if (params === undefined || params === null) return String(template)
return String(template).replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
}
/**
* 造一个翻译函数：优先用宿主 locale 服务，服务不可用或缺词条时回落到内置词典。
* @param {(key: string, params?: object) => string} [bound] - ctx.locale.bind(NS)
* @returns {(key: string, params?: object) => string} 翻译函数
*/
function makeTranslate(bound) { return function translate(key, params) { const fallback = TEXT[key] ?? TEXT_EN[key] ?? key
if (typeof bound === 'function') { try { const value = bound(key, params)
if (typeof value === 'string' && value !== '' && value !== key) return value
} catch {
/* locale 服务异常时回落到内置词典 */
}
}
return interpolate(fallback, params)
}
}
/** 字节数变成人话。 */
function formatBytes(bytes) { const value = Number(bytes)
if (!Number.isFinite(value) || value <= 0) return '0 B'
if (value < 1024) return `${Math.round(value)} B`
const units = ['KB', 'MB', 'GB', 'TB']
let size = value / 1024
let index = 0
while (size >= 1024 && index < units.length - 1) { size /= 1024
index += 1
}
return `${size >= 100 ? Math.round(size) : size.toFixed(1)} ${units[index]}`
}
/** 毫秒变成人话。 */
function formatDuration(ms) { const value = Number(ms)
if (!Number.isFinite(value) || value < 0) return '—'
if (value < 1000) return `${Math.round(value)} ms`
if (value < 60000) return `${(value / 1000).toFixed(1)} s`
return `${(value / 60000).toFixed(1)} min`
}
/** 时间戳变成本地时间。 */
function formatTime(timestamp) { const value = Number(timestamp)
if (!Number.isFinite(value) || value <= 0) return '—'
try { return new Date(value).toLocaleString()
} catch { return '—'
}
}
/** 统一取错误文本。 */
function errorText(payload, fallback) { if (payload === null || payload === undefined) return fallback
const detail = typeof payload.detail === 'string' && payload.detail !== '' ? payload.detail : ''
const message = typeof payload.message === 'string' && payload.message !== '' ? payload.message : ''
const error = typeof payload.error === 'string' && payload.error !== '' ? payload.error : ''
if (message !== '' && detail !== '') return `${message}（${detail}）`
if (message !== '' && error !== '') return `${message}（${error}）`
return message || error || detail || fallback
}
/** 回收失败时给一句人话：优先错误字段，其次机制说明。 */
function trimFailureText(payload, t) { if (payload === null || typeof payload !== 'object') return t('common.dash')
const direct = errorText(payload, '')
if (direct !== '') return direct
const mechanism = payload.mechanism
const detail = mechanism !== null && typeof mechanism === 'object' && typeof mechanism.detail === 'string' ? mechanism.detail : ''
return detail === '' ? t('common.dash') : detail
}
/**
* 调一次插件接口；任何失败都变成结果对象，绝不抛出。
* @param {'GET'|'POST'|'PUT'} method - HTTP 方法
* @param {string} path - 相对 API 前缀的路径
* @param {object} [body] - 请求体
* @returns {Promise<{ok: boolean, status: number, error: string, data: any}>} 结果
*/
async function apiRequest(method, path, body) { try { const init = { method, credentials: 'same-origin', headers: { accept: 'application/json' } }
if (body !== undefined) { init.headers['content-type'] = 'application/json'
init.body = JSON.stringify(body)
}
const response = await fetch(`${API}${path}`, init)
const payload = await response.json().catch(() => null)
if (!response.ok) { return { ok: false, status: response.status, error: errorText(payload, `HTTP ${response.status}`), data: null }
}
if (payload === null || typeof payload !== 'object') { return { ok: false, status: response.status, error: `HTTP ${response.status}: 响应不是 JSON`, data: null }
}
return { ok: true, status: response.status, error: '', data: payload }
} catch (error) { const message = error && typeof error.message === 'string' ? error.message : '网络请求失败'
return { ok: false, status: 0, error: message, data: null }
}
}
/** 判断一个对象像不像 config（防止把 {ok:false} 当成配置）。 */
function looksLikeConfig(payload) { if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return false
return CONFIG_KEYS.some(key => key in payload)
}
/**
* 从响应里取出 config。
* 兼容两种形状：{ ok:true, config:{...} } 与直接返回 config 对象。
* @param {unknown} payload - 响应体
* @returns {object|null} config 对象；认不出来时返回 null
*/
function extractConfig(payload) { if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null
const nested = payload.config
if (nested !== null && typeof nested === 'object' && !Array.isArray(nested)) return nested
return looksLikeConfig(payload) ? payload : null
}
/** 数字输入框的展示值（去掉多余的 0）。 */
function scaleToInput(value, factor) { const number = Number(value)
if (!Number.isFinite(number)) return ''
return String(Math.round((number / factor) * 1000) / 1000)
}
/** 配置对象 → 表单。 */
function configToForm(config) { const value = looksLikeConfig(config) ? config : {}
return { enabled: value.enabled !== false, thresholdMb: scaleToInput(value.thresholdBytes, BYTES_PER_MB), minIntervalSec: scaleToInput(value.minIntervalMs, MS_PER_SECOND),
idleIntervalSec: scaleToInput(value.idleIntervalMs, MS_PER_SECOND), hardCapMb: scaleToInput(value.hardCapBytes, BYTES_PER_MB), }
}
/** 表单 → 配置载荷（毫秒/字节换算回去；填错时沿用旧值）。 */
function formToPayload(form, fallback) { const base = looksLikeConfig(fallback) ? fallback : {}
return { enabled: form.enabled === true, thresholdBytes: pickNumber(form.thresholdMb, base.thresholdBytes, BYTES_PER_MB), minIntervalMs: pickNumber(form.minIntervalSec, base.minIntervalMs, MS_PER_SECOND),
idleIntervalMs: pickNumber(form.idleIntervalSec, base.idleIntervalMs, MS_PER_SECOND), hardCapBytes: pickNumber(form.hardCapMb, base.hardCapBytes, BYTES_PER_MB), }
}
/** 表单里的一格数字 → 真实单位；填不进去就用旧值。 */
function pickNumber(text, fallbackValue, factor) { const raw = typeof text === 'string' ? text.trim() : text
const parsed = raw === '' || raw === null || raw === undefined ? Number.NaN : Number(raw)
if (!Number.isFinite(parsed)) { const fallbackNumber = Number(fallbackValue)
return Number.isFinite(fallbackNumber) ? fallbackNumber : 0
}
return Math.round(parsed * factor)
}
/** 触发原因的可读文本。 */
function reasonText(reason, t) { const map = { 'threshold': 'reason.threshold', 'idle': 'reason.idle', 'hard-cap': 'reason.hardCap', 'disabled': 'reason.disabled', 'below-threshold': 'reason.belowThreshold',
'manual': 'reason.manual', }
const key = map[String(reason ?? '')] ?? 'reason.unknown'
return t(key)
}
/** 原生机制名的可读文本。 */
function mechanismText(name, t) { if (name === 'malloc_trim') return 'malloc_trim'
if (name === 'malloc_zone_pressure_relief') return 'malloc_zone_pressure_relief'
if (name === 'EmptyWorkingSet') return 'EmptyWorkingSet'
return t('mechanism.unknown')
}
const styles = { section: { display: 'flex', flexDirection: 'column', gap: '14px', fontSize: '13px', color: 'var(--dsw-alias-label-primary)' },
headerRow: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }, title: { margin: 0, fontSize: '15px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
description: { margin: '4px 0 0', fontSize: '12px', lineHeight: 1.6, color: 'var(--dsw-alias-label-tertiary)' },
panel: { padding: '14px 16px', borderRadius: '10px', border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)' },
panelTitle: { margin: '0 0 10px', fontSize: '13px', fontWeight: 600, color: 'var(--dsw-alias-label-secondary)' }, grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '10px' },
tile: { padding: '10px 12px', borderRadius: '8px', background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l1)' }, tileLabel: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' },
tileValue: { marginTop: '4px', fontSize: '15px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)', wordBreak: 'break-all' },
tileHint: { marginTop: '2px', fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' }, row: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
badge: { display: 'inline-flex', alignItems: 'center', padding: '2px 8px', borderRadius: '999px', fontSize: '11px', border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-secondary)' },
badgeOk: { color: 'var(--dsw-alias-state-success-primary)', borderColor: 'var(--dsw-alias-state-success-primary)' },
badgeBad: { color: 'var(--dsw-alias-state-error-primary)', borderColor: 'var(--dsw-alias-state-error-primary)' },
mono: { fontFamily: 'var(--dsw-font-markdown-code-font-family)', fontSize: '12px', color: 'var(--dsw-alias-label-primary)' }, hint: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)', lineHeight: 1.6 },
notice: { padding: '10px 12px', borderRadius: '8px', fontSize: '12px', lineHeight: 1.6, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-secondary)' },
warn: { color: 'var(--dsw-alias-state-warn-primary)', borderColor: 'var(--dsw-alias-state-warn-primary)' },
errorPanel: { padding: '12px 14px', borderRadius: '8px', border: '1px solid var(--dsw-alias-state-error-primary)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-state-error-primary)', fontSize: '13px', lineHeight: 1.6 },
errorLine: { marginTop: '8px', fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)', wordBreak: 'break-word' },
button: { padding: '6px 12px', borderRadius: '8px', border: '1px solid var(--dsw-alias-border-l1)', background: 'transparent', color: 'var(--dsw-alias-label-primary)', fontSize: '12px', cursor: 'pointer' },
buttonPrimary: { border: '1px solid transparent', background: 'var(--dsw-alias-button-primary-fill)', color: 'var(--dsw-alias-label-primary-foreground)' }, buttonDisabled: { opacity: 0.55, cursor: 'not-allowed' },
formGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '10px' },
field: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' }, fieldLabel: { minWidth: '110px', color: 'var(--dsw-alias-label-tertiary)' },
input: { width: '110px', padding: '5px 8px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', fontSize: '12px' },
unit: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '11px' }, }
/** 渲染错误兜底：组件抛错时不要把整个 slot 搞白。 */
class LowmemBoundary extends React.Component { constructor(props) { super(props)
this.state = { failed: false }
}
static getDerivedStateFromError() { return { failed: true }
}
render() { if (this.state.failed) return h('div', { style: styles.errorPanel }, this.props.message)
return this.props.children
}
}
/** 一个统计格子。 */
function statTile(key, label, value, hint) { return h('div', { key, style: styles.tile }, h('div', { style: styles.tileLabel }, label), h('div', { style: styles.tileValue }, value),
hint ? h('div', { style: styles.tileHint }, hint) : null)
}
/** 配置表单的一行。 */
function configField(key, label, input, unit) { return h('label', { key, style: styles.field }, h('span', { style: styles.fieldLabel }, label), input, unit ? h('span', { style: styles.unit }, unit) : null)
}
/**
* 设置页分区：内存快照 + 原生回收 + 累计统计 + 回收策略。
* @param {{t?: (key: string, params?: object) => string}} props - slot 传入的 props
* @returns {any} React 元素
*/
function LowmemSection(props) { const t = makeTranslate(props?.t)
const [stats, setStats] = useState(null)
const [form, setForm] = useState(null)
const [dirty, setDirty] = useState(false)
const [loading, setLoading] = useState(true)
const [loadError, setLoadError] = useState('')
const [pollError, setPollError] = useState('')
const [trimNotice, setTrimNotice] = useState('')
const [trimming, setTrimming] = useState(false)
const [saving, setSaving] = useState(false)
const [configNotice, setConfigNotice] = useState('')
const mounted = useRef(true)
const dirtyRef = useRef(false)
const trimBusyRef = useRef(false)
const saveBusyRef = useRef(false)
const latest = useRef({ stats: null, config: null })
const loadRef = useRef(null)
useEffect(() => { mounted.current = true
const load = async (initial) => { const statsResult = await apiRequest('GET', '/stats')
const configResult = initial ? await apiRequest('GET', '/config') : null
if (!mounted.current) return
if (statsResult.ok) { const payload = statsResult.data ?? {}
latest.current.stats = payload
setStats(payload)
setLoadError('')
setPollError('')
const statsConfig = extractConfig(payload.config)
if (statsConfig !== null) { latest.current.config = statsConfig
if (!dirtyRef.current) setForm(configToForm(statsConfig))
}
} else if (latest.current.stats === null) { setLoadError(statsResult.error)
} else { setPollError(statsResult.error)
}
if (configResult !== null && configResult !== undefined) { const loadedConfig = configResult.ok ? extractConfig(configResult.data) : null
if (loadedConfig !== null) { latest.current.config = loadedConfig
if (!dirtyRef.current) setForm(configToForm(loadedConfig))
} else if (!configResult.ok) { setConfigNotice(t('configUnavailable'))
}
}
setLoading(false)
}
loadRef.current = load
void load(true)
const timer = setInterval(() => { void load(false) }, POLL_INTERVAL_MS)
return () => { mounted.current = false
clearInterval(timer)
}
}, [])
const reload = () => { if (loadRef.current === null) return Promise.resolve()
return loadRef.current(true)
}
const updateField = (key, value) => { dirtyRef.current = true
setDirty(true)
setForm(current => (current === null ? current : { ...current, [key]: value }))
}
const discardChanges = () => { dirtyRef.current = false
setDirty(false)
const current = latest.current.config
if (current !== null) setForm(configToForm(current))
}
const handleTrim = async () => { if (trimBusyRef.current) return
trimBusyRef.current = true
setTrimming(true)
setTrimNotice('')
const result = await apiRequest('POST', '/trim', { force: true })
if (!mounted.current) return
trimBusyRef.current = false
setTrimming(false)
if (result.ok && result.data !== null && result.data.ok !== false) { const size = formatBytes(result.data.reclaimedBytes)
const duration = formatDuration(result.data.durationMs)
setTrimNotice(t('trimDone', { size, duration }))
} else { const detail = result.ok ? trimFailureText(result.data, t) : result.error
setTrimNotice(t('trimFailed', { detail }))
}
await reload()
}
const handleSave = async () => { if (saveBusyRef.current || form === null) return
saveBusyRef.current = true
setSaving(true)
setConfigNotice('')
const payload = formToPayload(form, latest.current.config)
const result = await apiRequest('PUT', '/config', payload)
if (!mounted.current) return
saveBusyRef.current = false
setSaving(false)
if (result.ok && result.data !== null && result.data.ok !== false) { const nextConfig = extractConfig(result.data) ?? payload
dirtyRef.current = false
setDirty(false)
latest.current.config = nextConfig
setForm(configToForm(nextConfig))
setConfigNotice(t('configSaved'))
} else { const detail = result.ok ? errorText(result.data, t('common.dash')) : result.error
setConfigNotice(t('configFailed', { detail }))
}
}
const header = h('div', { style: styles.headerRow }, h('div', null, h('h2', { style: styles.title }, t('settings.title')), h('p', { style: styles.description }, t('settings.description'))),
h('div', { style: styles.row }, h('span', { style: styles.hint }, t('updatedAt', { time: formatTime(Date.now()) })),
h('button', { type: 'button', style: styles.button, onClick: () => { void reload() } }, t('button.refresh'))))
const body = []
if (loading && stats === null) { body.push(h('div', { key: 'loading', style: styles.notice }, t('loading')))
} else if (stats === null) { body.push(h('div', { key: 'loadError', style: styles.errorPanel }, h('div', null, t('loadFailed', { detail: loadError === '' ? t('common.dash') : loadError })),
h('div', { style: { marginTop: '8px' } }, h('button', { type: 'button', style: styles.button, onClick: () => { void reload() } }, t('button.retry')))))
} else { const memory = stats.memory ?? {}
const mechanism = stats.mechanism ?? {}
const trim = stats.trim ?? {}
const available = mechanism.available === true
body.push(h('section', { key: 'memory', style: styles.panel }, h('h3', { style: styles.panelTitle }, t('section.memory')), h('div', { style: styles.grid }, statTile('rss', t('field.rss'), formatBytes(memory.rssBytes)),
statTile('heapUsed', t('field.heapUsed'), formatBytes(memory.heapUsedBytes)), statTile('heapTotal', t('field.heapTotal'), formatBytes(memory.heapTotalBytes)),
statTile('external', t('field.external'), formatBytes(memory.externalBytes)), statTile('arrayBuffer', t('field.arrayBuffer'), formatBytes(memory.arrayBufferBytes)),
statTile('uptime', t('field.uptime'), formatDuration(Number(memory.uptimeSeconds ?? 0) * MS_PER_SECOND), t('field.pid') + ': ' + String(memory.pid ?? t('common.dash'))))))
body.push(h('section', { key: 'mechanism', style: styles.panel }, h('h3', { style: styles.panelTitle }, t('section.mechanism')), h('div', { style: styles.row },
h('span', { key: 'badge', style: { ...styles.badge, ...(available ? styles.badgeOk : styles.badgeBad) } }, available ? t('mechanism.available') : t('mechanism.unavailable')),
h('span', { key: 'name', style: styles.mono }, mechanismText(mechanism.name, t)),
h('span', { key: 'detail', style: styles.hint }, mechanism.detail === undefined || mechanism.detail === '' ? t('common.dash') : String(mechanism.detail)))))
body.push(h('section', { key: 'trim', style: styles.panel }, h('h3', { style: styles.panelTitle }, t('section.trim')), h('div', { style: styles.grid }, statTile('count', t('field.count'), String(trim.count ?? 0)),
statTile('total', t('field.totalReclaimed'), formatBytes(trim.totalReclaimedBytes)), statTile('last', t('field.lastReclaimed'), formatBytes(trim.lastReclaimedBytes)),
statTile('duration', t('field.lastDuration'), formatDuration(trim.lastDurationMs)), statTile('at', t('field.lastAt'), formatTime(trim.lastAt)), statTile('reason', t('field.lastReason'), reasonText(trim.lastReason, t))),
trim.lastError ? h('div', { key: 'lastError', style: styles.errorLine }, t('field.lastError') + ': ' + String(trim.lastError)) : null, h('div', { key: 'actions', style: { ...styles.row, marginTop: '12px' } },
h('button', { type: 'button', style: { ...styles.button, ...styles.buttonPrimary }, disabled: trimming, onClick: () => { void handleTrim() } }, trimming ? t('button.trimming') : t('button.trim')),
trimNotice === '' ? null : h('span', { key: 'notice', style: styles.hint }, trimNotice))))
body.push(h('section', { key: 'config', style: styles.panel }, h('h3', { style: styles.panelTitle }, t('section.config')), form === null
? h('div', { style: styles.notice }, t('configUnavailable'))
: h('div', { style: styles.formGrid },
configField('enabled', t('field.enabled'), h('input', { type: 'checkbox', checked: form.enabled === true, onChange: event => updateField('enabled', event.target.checked === true) })),
configField('threshold', t('field.threshold'), h('input', { type: 'number', min: '0', step: '1', value: form.thresholdMb, onChange: event => updateField('thresholdMb', event.target.value) }), t('unit.mb')),
configField('hardCap', t('field.hardCap'), h('input', { type: 'number', min: '0', step: '1', value: form.hardCapMb, onChange: event => updateField('hardCapMb', event.target.value) }), t('unit.mb')),
configField('minInterval', t('field.minInterval'), h('input', { type: 'number', min: '0', step: '1', value: form.minIntervalSec, onChange: event => updateField('minIntervalSec', event.target.value) }), t('unit.second')),
configField('idleInterval', t('field.idleInterval'), h('input', { type: 'number', min: '0', step: '1', value: form.idleIntervalSec, onChange: event => updateField('idleIntervalSec', event.target.value) }), t('unit.second'))),
h('div', { key: 'configActions', style: { ...styles.row, marginTop: '12px' } },
h('button', { type: 'button', style: { ...styles.button, ...styles.buttonPrimary }, disabled: saving || !dirty, onClick: () => { void handleSave() } }, saving ? t('button.saving') : t('button.save')),
dirty ? h('button', { key: 'discard', type: 'button', style: styles.button, onClick: discardChanges }, t('button.discard')) : null,
configNotice === '' ? null : h('span', { key: 'configNotice', style: styles.hint }, configNotice))))
if (pollError !== '') { body.push(h('div', { key: 'pollError', style: { ...styles.notice, ...styles.warn } }, t('pollFailed', { detail: pollError })))
}
}
return h(LowmemBoundary, { message: t('error.boundary') }, h('div', { style: styles.section }, header, ...body))
}
return { inject: ['slots', 'locale'], apply(ctx) { ctx.effect(() => ctx.locale.register(NS, { zh: TEXT, en: TEXT_EN }), 'lowmem: 词典')
const t = ctx.locale.bind(NS)
ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'dsh-lowmem', order: 70, locale: NS, label: () => t('settings.title'), }, props => h(LowmemSection, { ...props, t })))
}, }
}, })
