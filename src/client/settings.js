    // ---------------------------------------------------------------------
    // 主题样式：只用 --dsw-alias-* token，不写死颜色
    // ---------------------------------------------------------------------
    const styles = {
      section: { display: 'flex', flexDirection: 'column', gap: '14px', fontSize: '13px', color: 'var(--dsw-alias-label-primary)' },
      headerRow: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' },
      title: { margin: 0, fontSize: '15px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      description: { margin: '4px 0 0', fontSize: '12px', lineHeight: 1.6, color: 'var(--dsw-alias-label-tertiary)' },
      panel: { padding: '14px 16px', borderRadius: '10px', border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)' },
      panelTitle: { margin: '0 0 10px', fontSize: '13px', fontWeight: 600, color: 'var(--dsw-alias-label-secondary)' },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '10px' },
      tile: { padding: '10px 12px', borderRadius: '8px', background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l1)' },
      tileLabel: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' },
      tileValue: { marginTop: '4px', fontSize: '15px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)', wordBreak: 'break-all' },
      tileHint: { marginTop: '2px', fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' },
      row: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
      badge: { display: 'inline-flex', alignItems: 'center', padding: '2px 8px', borderRadius: '999px', fontSize: '11px', border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-secondary)' },
      badgeOk: { color: 'var(--dsw-alias-state-success-primary)', borderColor: 'var(--dsw-alias-state-success-primary)' },
      badgeBad: { color: 'var(--dsw-alias-state-error-primary)', borderColor: 'var(--dsw-alias-state-error-primary)' },
      mono: { fontFamily: 'var(--dsw-font-markdown-code-font-family)', fontSize: '12px', color: 'var(--dsw-alias-label-primary)' },
      hint: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)', lineHeight: 1.6 },
      notice: { padding: '10px 12px', borderRadius: '8px', fontSize: '12px', lineHeight: 1.6, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-secondary)' },
      warn: { color: 'var(--dsw-alias-state-warn-primary)', borderColor: 'var(--dsw-alias-state-warn-primary)' },
      errorPanel: { padding: '12px 14px', borderRadius: '8px', border: '1px solid var(--dsw-alias-state-error-primary)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-state-error-primary)', fontSize: '13px', lineHeight: 1.6 },
      errorLine: { marginTop: '8px', fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)', wordBreak: 'break-word' },
      button: { padding: '6px 12px', borderRadius: '8px', border: '1px solid var(--dsw-alias-border-l1)', background: 'transparent', color: 'var(--dsw-alias-label-primary)', fontSize: '12px', cursor: 'pointer' },
      buttonPrimary: { border: '1px solid transparent', background: 'var(--dsw-alias-button-primary-fill)', color: 'var(--dsw-alias-label-primary-foreground)' },
      buttonDisabled: { opacity: 0.55, cursor: 'not-allowed' },
      formGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '10px' },
      field: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
      fieldLabel: { minWidth: '110px', color: 'var(--dsw-alias-label-tertiary)' },
      input: { width: '110px', padding: '5px 8px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', fontSize: '12px' },
      unit: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '11px' },
      // 数字输入框固定宽度：不然它会把右侧的单位（MB / 秒）挤出面板，看不出数值是什么单位。
      numberInput: { width: '96px', padding: '4px 8px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)' },
    }

    /** 渲染错误兜底：组件抛错时不要把整个 slot 搞白。 */
    class LowmemBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: false }
      }
      static getDerivedStateFromError() {
        return { failed: true }
      }
      render() {
        if (this.state.failed) return h('div', { style: styles.errorPanel }, this.props.message)
        return this.props.children
      }
    }

    /** 一个统计格子。 */
    function statTile(key, label, value, hint) {
      return h('div', { key, style: styles.tile },
        h('div', { style: styles.tileLabel }, label),
        h('div', { style: styles.tileValue }, value),
        hint ? h('div', { style: styles.tileHint }, hint) : null)
    }

    /** 配置表单的一行。 */
    function configField(key, label, input, unit) {
      return h('label', { key, style: styles.field },
        h('span', { style: styles.fieldLabel }, label),
        input,
        unit ? h('span', { style: styles.unit }, unit) : null)
    }

    /**
     * 设置页分区：内存快照 + 原生回收 + 累计统计 + 回收策略。
     * @param {{t?: (key: string, params?: object) => string}} props - slot 传入的 props
     * @returns {any} React 元素
     */
    function LowmemSection(props) {
      const t = makeTranslate(props?.t)
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

      useEffect(() => {
        mounted.current = true
        const load = async (initial) => {
          const statsResult = await apiRequest('GET', '/stats')
          const configResult = initial ? await apiRequest('GET', '/config') : null
          if (!mounted.current) return
          if (statsResult.ok) {
            const payload = statsResult.data ?? {}
            latest.current.stats = payload
            setStats(payload)
            setLoadError('')
            setPollError('')
            const statsConfig = extractConfig(payload.config)
            if (statsConfig !== null) {
              latest.current.config = statsConfig
              if (!dirtyRef.current) setForm(configToForm(statsConfig))
            }
          } else if (latest.current.stats === null) {
            setLoadError(statsResult.error)
          } else {
            setPollError(statsResult.error)
          }
          if (configResult !== null && configResult !== undefined) {
            const loadedConfig = configResult.ok ? extractConfig(configResult.data) : null
            if (loadedConfig !== null) {
              latest.current.config = loadedConfig
              if (!dirtyRef.current) setForm(configToForm(loadedConfig))
            } else if (!configResult.ok) {
              setConfigNotice(t('configUnavailable'))
            }
          }
          setLoading(false)
        }
        loadRef.current = load
        void load(true)
        const timer = setInterval(() => { void load(false) }, POLL_INTERVAL_MS)
        return () => {
          mounted.current = false
          clearInterval(timer)
        }
      }, [])

      const reload = () => {
        if (loadRef.current === null) return Promise.resolve()
        return loadRef.current(true)
      }

      const updateField = (key, value) => {
        dirtyRef.current = true
        setDirty(true)
        setForm(current => (current === null ? current : { ...current, [key]: value }))
      }

      const discardChanges = () => {
        dirtyRef.current = false
        setDirty(false)
        const current = latest.current.config
        if (current !== null) setForm(configToForm(current))
      }

      const handleTrim = async () => {
        if (trimBusyRef.current) return
        trimBusyRef.current = true
        setTrimming(true)
        setTrimNotice('')
        const result = await apiRequest('POST', '/trim', { force: true })
        if (!mounted.current) return
        trimBusyRef.current = false
        setTrimming(false)
        if (result.ok && result.data !== null && result.data.ok !== false) {
          const size = formatBytes(result.data.reclaimedBytes)
          const duration = formatDuration(result.data.durationMs)
          setTrimNotice(t('trimDone', { size, duration }))
        } else {
          const detail = result.ok ? trimFailureText(result.data, t) : result.error
          setTrimNotice(t('trimFailed', { detail }))
        }
        await reload()
      }

      const handleSave = async () => {
        if (saveBusyRef.current || form === null) return
        saveBusyRef.current = true
        setSaving(true)
        setConfigNotice('')
        const payload = formToPayload(form, latest.current.config)
        const result = await apiRequest('PUT', '/config', payload)
        if (!mounted.current) return
        saveBusyRef.current = false
        setSaving(false)
        if (result.ok && result.data !== null && result.data.ok !== false) {
          const nextConfig = extractConfig(result.data) ?? payload
          dirtyRef.current = false
          setDirty(false)
          latest.current.config = nextConfig
          setForm(configToForm(nextConfig))
          setConfigNotice(t('configSaved'))
        } else {
          const detail = result.ok ? errorText(result.data, t('common.dash')) : result.error
          setConfigNotice(t('configFailed', { detail }))
        }
      }

      const header = h('div', { style: styles.headerRow },
        h('div', null,
          h('h2', { style: styles.title }, t('settings.title')),
          h('p', { style: styles.description }, t('settings.description'))),
        h('div', { style: styles.row },
          h('span', { style: styles.hint }, t('updatedAt', { time: formatTime(Date.now()) })),
          h('button', { type: 'button', style: styles.button, onClick: () => { void reload() } }, t('button.refresh'))))

      const body = []
      if (loading && stats === null) {
        body.push(h('div', { key: 'loading', style: styles.notice }, t('loading')))
      } else if (stats === null) {
        body.push(h('div', { key: 'loadError', style: styles.errorPanel },
          h('div', null, t('loadFailed', { detail: loadError === '' ? t('common.dash') : loadError })),
          h('div', { style: { marginTop: '8px' } },
            h('button', { type: 'button', style: styles.button, onClick: () => { void reload() } }, t('button.retry')))))
      } else {
        const memory = stats.memory ?? {}
        const mechanism = stats.mechanism ?? {}
        const trim = stats.trim ?? {}
        const available = mechanism.available === true
        body.push(h('section', { key: 'memory', style: styles.panel },
          h('h3', { style: styles.panelTitle }, t('section.memory')),
          h('div', { style: styles.grid },
            statTile('rss', t('field.rss'), formatBytes(memory.rssBytes)),
            statTile('heapUsed', t('field.heapUsed'), formatBytes(memory.heapUsedBytes)),
            statTile('heapTotal', t('field.heapTotal'), formatBytes(memory.heapTotalBytes)),
            statTile('external', t('field.external'), formatBytes(memory.externalBytes)),
            statTile('arrayBuffer', t('field.arrayBuffer'), formatBytes(memory.arrayBufferBytes)),
            statTile('uptime', t('field.uptime'), formatDuration(Number(memory.uptimeSeconds ?? 0) * MS_PER_SECOND), t('field.pid') + ': ' + String(memory.pid ?? t('common.dash'))))))
        body.push(h('section', { key: 'mechanism', style: styles.panel },
          h('h3', { style: styles.panelTitle }, t('section.mechanism')),
          h('div', { style: styles.row },
            h('span', { key: 'badge', style: { ...styles.badge, ...(available ? styles.badgeOk : styles.badgeBad) } }, available ? t('mechanism.available') : t('mechanism.unavailable')),
            h('span', { key: 'name', style: styles.mono }, mechanismText(mechanism.name, t)),
            h('span', { key: 'detail', style: styles.hint }, mechanism.detail === undefined || mechanism.detail === '' ? t('common.dash') : String(mechanism.detail)))))
        body.push(h('section', { key: 'trim', style: styles.panel },
          h('h3', { style: styles.panelTitle }, t('section.trim')),
          h('div', { style: styles.grid },
            statTile('count', t('field.count'), String(trim.count ?? 0)),
            statTile('total', t('field.totalReclaimed'), formatBytes(trim.totalReclaimedBytes)),
            statTile('last', t('field.lastReclaimed'), formatBytes(trim.lastReclaimedBytes)),
            statTile('duration', t('field.lastDuration'), formatDuration(trim.lastDurationMs)),
            statTile('at', t('field.lastAt'), formatTime(trim.lastAt)),
            statTile('reason', t('field.lastReason'), reasonText(trim.lastReason, t))),
          trim.lastError ? h('div', { key: 'lastError', style: styles.errorLine }, t('field.lastError') + ': ' + String(trim.lastError)) : null,
          h('div', { key: 'actions', style: { ...styles.row, marginTop: '12px' } },
            h('button', { type: 'button', style: { ...styles.button, ...styles.buttonPrimary }, disabled: trimming, onClick: () => { void handleTrim() } }, trimming ? t('button.trimming') : t('button.trim')),
            trimNotice === '' ? null : h('span', { key: 'notice', style: styles.hint }, trimNotice))))
        body.push(h('section', { key: 'config', style: styles.panel },
          h('h3', { style: styles.panelTitle }, t('section.config')),
          form === null
            ? h('div', { style: styles.notice }, t('configUnavailable'))
            : h('div', { style: styles.formGrid },
              configField('enabled', t('field.enabled'), h('input', { type: 'checkbox', checked: form.enabled === true, onChange: event => updateField('enabled', event.target.checked === true) })),
              configField('threshold', t('field.threshold'), h('input', { type: 'number', min: '0', step: '1', style: styles.numberInput, value: form.thresholdMb, onChange: event => updateField('thresholdMb', event.target.value) }), t('unit.mb')),
              configField('hardCap', t('field.hardCap'), h('input', { type: 'number', min: '0', step: '1', style: styles.numberInput, value: form.hardCapMb, onChange: event => updateField('hardCapMb', event.target.value) }), t('unit.mb')),
              configField('minInterval', t('field.minInterval'), h('input', { type: 'number', min: '0', step: '1', style: styles.numberInput, value: form.minIntervalSec, onChange: event => updateField('minIntervalSec', event.target.value) }), t('unit.second')),
              configField('idleInterval', t('field.idleInterval'), h('input', { type: 'number', min: '0', step: '1', style: styles.numberInput, value: form.idleIntervalSec, onChange: event => updateField('idleIntervalSec', event.target.value) }), t('unit.second'))),
          h('div', { key: 'configActions', style: { ...styles.row, marginTop: '12px' } },
            h('button', { type: 'button', style: { ...styles.button, ...styles.buttonPrimary }, disabled: saving || !dirty, onClick: () => { void handleSave() } }, saving ? t('button.saving') : t('button.save')),
            dirty ? h('button', { key: 'discard', type: 'button', style: styles.button, onClick: discardChanges }, t('button.discard')) : null,
            configNotice === '' ? null : h('span', { key: 'configNotice', style: styles.hint }, configNotice))))
        if (pollError !== '') {
          body.push(h('div', { key: 'pollError', style: { ...styles.notice, ...styles.warn } }, t('pollFailed', { detail: pollError })))
        }
      }

      return h(LowmemBoundary, { message: t('error.boundary') },
        h('div', { style: styles.section }, header, ...body))
    }
