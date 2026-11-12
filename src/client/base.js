    const NS = 'lowmem'
    const API = '/api/dsh-lowmem'
    const POLL_INTERVAL_MS = 5000
    const BYTES_PER_MB = 1048576
    const MS_PER_SECOND = 1000
    const CONFIG_KEYS = ['enabled', 'thresholdBytes', 'minIntervalMs', 'idleIntervalMs', 'hardCapBytes', 'sampleIntervalMs']

    /** 中文词典。 */
    const TEXT = {
      'settings.title': '内存回收',
      'settings.description': '查看进程内存占用，手动或按策略触发原生内存回收。',
      'section.memory': '当前内存',
      'section.mechanism': '原生回收机制',
      'section.trim': '累计统计',
      'section.config': '回收策略',
      'section.activity': '活跃状态',
      'section.allocator': '分配器建议',
      'field.rss': '常驻内存 RSS',
      'field.rssPeak': '峰值 RSS',
      'field.heapUsed': 'V8 堆已用',
      'field.heapTotal': 'V8 堆总量',
      'field.heapResident': '堆常驻 [heap]',
      'field.external': '外部内存',
      'field.arrayBuffer': 'ArrayBuffer',
      'field.uptime': '运行时长',
      'field.pid': '进程 PID',
      'field.count': '回收次数',
      'field.totalAmount': '累计回收量',
      'field.lastAmount': '上次回收量',
      'field.nativeReleased': '上次原生释放量',
      'field.lastDuration': '上次耗时',
      'field.lastAt': '上次时间',
      'field.lastReason': '触发原因',
      'field.lastError': '上次错误',
      'field.byReason': '触发原因分布',
      'field.enabled': '启用自动回收',
      'field.threshold': '触发阈值',
      'field.minInterval': '最小回收间隔',
      'field.idleInterval': '空闲兜底间隔',
      'field.hardCap': '硬上限',
      'field.sampleInterval': '采样间隔',
      'field.status': '运行状态',
      'field.running': '运行中',
      'field.idle': '空闲',
      'field.activeAgents': '活跃 agent 数',
      'field.activeJobs': '活跃后台任务数',
      'mechanism.available': '可用',
      'mechanism.unavailable': '不可用',
      'mechanism.unknown': '未知机制',
      'mechanism.kindReclaim': '真的还给操作系统',
      'mechanism.kindSwapOut': '换出到页面文件（不等于释放）',
      'mechanism.kindUnknown': '机制类型未知',
      'word.released': '已释放',
      'word.swapped': '已换出',
      'word.rssDelta': 'RSS 变化',
      'reason.threshold': '达到阈值',
      'reason.idle': '空闲兜底',
      'reason.hardCap': '超过硬上限',
      'reason.disabled': '策略已禁用',
      'reason.belowThreshold': '未达阈值',
      'reason.manual': '手动触发',
      'reason.unknown': '未知',
      'button.trim': '立即回收',
      'button.trimming': '正在回收…',
      'button.refresh': '刷新',
      'button.retry': '重试',
      'button.save': '保存',
      'button.saving': '保存中…',
      'button.discard': '放弃修改',
      'loading': '正在读取内存状态…',
      'loadFailed': '读取内存状态失败：{detail}',
      'pollFailed': '刷新失败（仍显示上次数据）：{detail}',
      'trim.released': '已释放 {size}，耗时 {duration}',
      'trim.swapped': '已换出 {size}，耗时 {duration}',
      'trim.rssDelta': '本次 RSS 变化 {size}，耗时 {duration}',
      'trim.swapHint': '后续访问这些页会变慢（页缺失 → 软缺页 → 磁盘读）',
      'trim.nativeAmount': '原生释放 {size}',
      'trimFailed': '回收失败：{detail}',
      'configSaved': '配置已保存',
      'configFailed': '保存配置失败：{detail}',
      'configUnavailable': '配置接口不可用，暂时无法修改策略。',
      'allocator.pinned': '已按推荐配置启动',
      'allocator.recommend': '建议以 MALLOC_MMAP_THRESHOLD_=131072 启动宿主',
      'allocator.benefit': '实测收益：峰值 RSS -80%、可回收碎片 -98%',
      'allocator.command': '启动命令：MALLOC_MMAP_THRESHOLD_=131072 dsh --profile web',
      'updatedAt': '更新于 {time}',
      'unit.mb': 'MB',
      'unit.second': '秒',
      'common.dash': '—',
      'error.boundary': '这个分区渲染出错了，其它功能不受影响。',
    }

    /** 英文词典（键与中文完全一致）。 */
    const TEXT_EN = {
      'settings.title': 'Memory trim',
      'settings.description': 'Inspect process memory and trigger native reclamation on demand or by policy.',
      'section.memory': 'Current memory',
      'section.mechanism': 'Native reclamation',
      'section.trim': 'Cumulative stats',
      'section.config': 'Trim policy',
      'section.activity': 'Activity',
      'section.allocator': 'Allocator advice',
      'field.rss': 'Resident memory (RSS)',
      'field.rssPeak': 'Peak RSS',
      'field.heapUsed': 'V8 heap used',
      'field.heapTotal': 'V8 heap total',
      'field.heapResident': 'Heap resident [heap]',
      'field.external': 'External memory',
      'field.arrayBuffer': 'ArrayBuffer',
      'field.uptime': 'Uptime',
      'field.pid': 'Process PID',
      'field.count': 'Trim count',
      'field.totalAmount': 'Total reclaimed',
      'field.lastAmount': 'Last reclaimed',
      'field.nativeReleased': 'Last native released',
      'field.lastDuration': 'Last duration',
      'field.lastAt': 'Last trim',
      'field.lastReason': 'Last reason',
      'field.lastError': 'Last error',
      'field.byReason': 'Trim count by reason',
      'field.enabled': 'Enable automatic trim',
      'field.threshold': 'Growth threshold',
      'field.minInterval': 'Minimum interval',
      'field.idleInterval': 'Idle fallback interval',
      'field.hardCap': 'Hard cap',
      'field.sampleInterval': 'Sample interval',
      'field.status': 'Run state',
      'field.running': 'running',
      'field.idle': 'idle',
      'field.activeAgents': 'Active agents',
      'field.activeJobs': 'Active background jobs',
      'mechanism.available': 'available',
      'mechanism.unavailable': 'unavailable',
      'mechanism.unknown': 'unknown mechanism',
      'mechanism.kindReclaim': 'really returned to the OS',
      'mechanism.kindSwapOut': 'swapped out to the page file (not released)',
      'mechanism.kindUnknown': 'unknown mechanism kind',
      'word.released': 'Released',
      'word.swapped': 'Swapped out',
      'word.rssDelta': 'RSS change',
      'reason.threshold': 'threshold reached',
      'reason.idle': 'idle fallback',
      'reason.hardCap': 'hard cap exceeded',
      'reason.disabled': 'policy disabled',
      'reason.belowThreshold': 'below threshold',
      'reason.manual': 'manual',
      'reason.unknown': 'unknown',
      'button.trim': 'Trim now',
      'button.trimming': 'Trimming…',
      'button.refresh': 'Refresh',
      'button.retry': 'Retry',
      'button.save': 'Save',
      'button.saving': 'Saving…',
      'button.discard': 'Discard changes',
      'loading': 'Loading memory status…',
      'loadFailed': 'Failed to load memory status: {detail}',
      'pollFailed': 'Refresh failed (showing the previous data): {detail}',
      'trim.released': 'Released {size} in {duration}',
      'trim.swapped': 'Swapped out {size} in {duration}',
      'trim.rssDelta': 'RSS changed by {size} this time, in {duration}',
      'trim.swapHint': 'later access to these pages is slower (page missing → soft fault → disk read)',
      'trim.nativeAmount': 'Native released {size}',
      'trimFailed': 'Trim failed: {detail}',
      'configSaved': 'Configuration saved',
      'configFailed': 'Failed to save configuration: {detail}',
      'configUnavailable': 'The configuration API is unavailable; the policy cannot be changed for now.',
      'allocator.pinned': 'Started with the recommended configuration',
      'allocator.recommend': 'Start the host with MALLOC_MMAP_THRESHOLD_=131072',
      'allocator.benefit': 'Measured: peak RSS -80%, reclaimable fragmentation -98%',
      'allocator.command': 'Launch command: MALLOC_MMAP_THRESHOLD_=131072 dsh --profile web',
      'updatedAt': 'Updated at {time}',
      'unit.mb': 'MB',
      'unit.second': 'seconds',
      'common.dash': '—',
      'error.boundary': 'This section failed to render; everything else keeps working.',
    }

    /** 把 {name} 占位符替换掉。 */
    function interpolate(template, params) {
      if (params === undefined || params === null) return String(template)
      return String(template).replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
    }

    /**
     * 造一个翻译函数：优先用宿主 locale 服务，服务不可用或缺词条时回落到内置词典。
     * @param {(key: string, params?: object) => string} [bound] - ctx.locale.bind(NS)
     * @returns {(key: string, params?: object) => string} 翻译函数
     */
    function makeTranslate(bound) {
      return function translate(key, params) {
        const fallback = TEXT[key] ?? TEXT_EN[key] ?? key
        if (typeof bound === 'function') {
          try {
            const value = bound(key, params)
            if (typeof value === 'string' && value !== '' && value !== key) return value
          } catch {
            /* locale 服务异常时回落到内置词典 */
          }
        }
        return interpolate(fallback, params)
      }
    }

    /** 字节数变成人话。 */
    function formatBytes(bytes) {
      const value = Number(bytes)
      if (!Number.isFinite(value) || value <= 0) return '0 B'
      if (value < 1024) return `${Math.round(value)} B`
      const units = ['KB', 'MB', 'GB', 'TB']
      let size = value / 1024
      let index = 0
      while (size >= 1024 && index < units.length - 1) {
        size /= 1024
        index += 1
      }
      return `${size >= 100 ? Math.round(size) : size.toFixed(1)} ${units[index]}`
    }

    /** 毫秒变成人话。 */
    function formatDuration(ms) {
      const value = Number(ms)
      if (!Number.isFinite(value) || value < 0) return '—'
      if (value < 1000) return `${Math.round(value)} ms`
      if (value < 60000) return `${(value / 1000).toFixed(1)} s`
      return `${(value / 60000).toFixed(1)} min`
    }

    /** 时间戳变成本地时间。 */
    function formatTime(timestamp) {
      const value = Number(timestamp)
      if (!Number.isFinite(value) || value <= 0) return '—'
      try {
        return new Date(value).toLocaleString()
      } catch {
        return '—'
      }
    }

    /** 统一取错误文本。 */
    function errorText(payload, fallback) {
      if (payload === null || payload === undefined) return fallback
      const detail = typeof payload.detail === 'string' && payload.detail !== '' ? payload.detail : ''
      const message = typeof payload.message === 'string' && payload.message !== '' ? payload.message : ''
      const error = typeof payload.error === 'string' && payload.error !== '' ? payload.error : ''
      if (message !== '' && detail !== '') return `${message}（${detail}）`
      if (message !== '' && error !== '') return `${message}（${error}）`
      return message || error || detail || fallback
    }

    /** 回收失败时给一句人话：优先错误字段，其次机制说明。 */
    function trimFailureText(payload, t) {
      if (payload === null || typeof payload !== 'object') return t('common.dash')
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
    async function apiRequest(method, path, body) {
      try {
        const init = { method, credentials: 'same-origin', headers: { accept: 'application/json' } }
        if (body !== undefined) {
          init.headers['content-type'] = 'application/json'
          init.body = JSON.stringify(body)
        }
        const response = await fetch(`${API}${path}`, init)
        const payload = await response.json().catch(() => null)
        if (!response.ok) {
          return { ok: false, status: response.status, error: errorText(payload, `HTTP ${response.status}`), data: null }
        }
        if (payload === null || typeof payload !== 'object') {
          return { ok: false, status: response.status, error: `HTTP ${response.status}: 响应不是 JSON`, data: null }
        }
        return { ok: true, status: response.status, error: '', data: payload }
      } catch (error) {
        const message = error && typeof error.message === 'string' ? error.message : '网络请求失败'
        return { ok: false, status: 0, error: message, data: null }
      }
    }

    /** 判断一个对象像不像 config（防止把 {ok:false} 当成配置）。 */
    function looksLikeConfig(payload) {
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return false
      return CONFIG_KEYS.some(key => key in payload)
    }

    /**
     * 从响应里取出 config。
     * 兼容两种形状：{ ok:true, config:{...} } 与直接返回 config 对象。
     * @param {unknown} payload - 响应体
     * @returns {object|null} config 对象；认不出来时返回 null
     */
    function extractConfig(payload) {
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null
      const nested = payload.config
      if (nested !== null && typeof nested === 'object' && !Array.isArray(nested)) return nested
      return looksLikeConfig(payload) ? payload : null
    }

    /**
     * 机制类型：'reclaim' | 'swap-out' | null。
     * 缺失或类型不对都当 null（界面退回中性说法）。
     * @param {unknown} mechanism - mechanism 段
     * @returns {string|null} 机制类型
     */
    function mechanismKind(mechanism) {
      if (mechanism === null || typeof mechanism !== 'object') return null
      const kind = mechanism.kind
      return typeof kind === 'string' && kind !== '' ? kind : null
    }

    /**
     * 回收量文案按机制类型分流（契约 §2.5）：
     * - reclaim：真的还给 OS → 「已释放」
     * - swap-out：只是换出到页面文件 → 「已换出」+ 变慢提示
     * - 其它/缺失：中性说法 → 「RSS 变化」，不暗示释放给了操作系统
     * @param {unknown} mechanism - mechanism 段
     * @returns {{word: string, sentence: string, swap: boolean}} 文案键与是否需要换出提示
     */
    function reclaimKeys(mechanism) {
      const kind = mechanismKind(mechanism)
      if (kind === 'reclaim') return { word: 'word.released', sentence: 'trim.released', swap: false }
      if (kind === 'swap-out') return { word: 'word.swapped', sentence: 'trim.swapped', swap: true }
      return { word: 'word.rssDelta', sentence: 'trim.rssDelta', swap: false }
    }

    /** 触发原因的可读文本。 */
    function reasonText(reason, t) {
      const map = {
        'threshold': 'reason.threshold',
        'idle': 'reason.idle',
        'hard-cap': 'reason.hardCap',
        'disabled': 'reason.disabled',
        'below-threshold': 'reason.belowThreshold',
        'manual': 'reason.manual',
      }
      const key = map[String(reason ?? '')] ?? 'reason.unknown'
      return t(key)
    }

    /** 原生机制名的可读文本。 */
    function mechanismText(name, t) {
      if (name === 'malloc_trim') return 'malloc_trim'
      if (name === 'malloc_zone_pressure_relief') return 'malloc_zone_pressure_relief'
      if (name === 'EmptyWorkingSet') return 'EmptyWorkingSet'
      return t('mechanism.unknown')
    }
