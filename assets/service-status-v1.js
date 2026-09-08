const root = document.getElementById('cfsm-service-status-root')

if (root) {
  const HISTORY_SLOT_MS = 15 * 60 * 1000
  const HISTORY_SLOT_COUNT = 96
  const stateLabels = {
    operational: '运行正常',
    degraded: '性能下降',
    unavailable: '不可用',
    maintenance: '维护中',
    auth_required: '需要登录',
    error: '检查异常',
    stale: '状态过期'
  }
  const stateSeverity = {
    operational: 0,
    maintenance: 1,
    degraded: 2,
    auth_required: 3,
    unavailable: 4,
    error: 5,
    stale: 5
  }

  let activeServerId = ''
  let refreshTimer = null
  let lastRenderKey = ''
  let placementTimer = 0
  let isPlacedInInstanceFlow = false

  const getApiBase = () => {
    const raw = document.querySelector('meta[name="apiBase"]')?.content?.trim() || ''
    const first = raw.split(',').map(item => item.trim()).find(Boolean)
    if (!first) return window.location.origin
    try {
      return new URL(first, window.location.href).origin
    } catch {
      return window.location.origin
    }
  }

  const getServerId = () => {
    const route = window.location.hash.startsWith('#/')
      ? window.location.hash.slice(1)
      : window.location.pathname
    const match = route.match(/^\/server\/([^/?#]+)/i)
    if (!match) return ''
    try {
      return decodeURIComponent(match[1])
    } catch {
      return match[1]
    }
  }

  const authHeaders = () => {
    const headers = { Accept: 'application/json' }
    try {
      const jwt = window.localStorage.getItem('jwt_token') || ''
      if (jwt) headers.Authorization = `Bearer ${jwt}`
      const turnstile = window.localStorage.getItem('turnstile_verified') || ''
      if (turnstile) headers['X-Turnstile-Verified'] = turnstile
    } catch {}
    return headers
  }

  const formatAge = (checkedAt) => {
    const ts = Number(checkedAt)
    if (!Number.isFinite(ts) || ts <= 0) return '无检查时间'
    const ageMs = Math.max(0, Date.now() - (ts < 1e10 ? ts * 1000 : ts))
    const seconds = Math.floor(ageMs / 1000)
    if (seconds < 90) return '刚刚检查'
    if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`
    return `${Math.floor(seconds / 3600)} 小时前`
  }

  const buildHistorySlots = (samples, latestCheckedAt, latestReportedState) => {
    const observed = Array.isArray(samples) ? [...samples] : []
    if (
      Number.isFinite(latestCheckedAt) && latestCheckedAt > 0 &&
      !observed.some(sample => Math.abs(sample.checkedAt - latestCheckedAt) < 1000)
    ) {
      observed.push({ state: latestReportedState, checkedAt: latestCheckedAt })
    }

    const currentBucket = Math.floor(Date.now() / HISTORY_SLOT_MS)
    const firstBucket = currentBucket - HISTORY_SLOT_COUNT + 1
    const byBucket = new Map()
    for (const sample of observed) {
      const bucket = Math.floor(sample.checkedAt / HISTORY_SLOT_MS)
      if (bucket < firstBucket || bucket > currentBucket) continue
      const previous = byBucket.get(bucket)
      if (!previous || (stateSeverity[sample.state] ?? 5) >= (stateSeverity[previous.state] ?? 5)) {
        byBucket.set(bucket, sample)
      }
    }

    return Array.from({ length: HISTORY_SLOT_COUNT }, (_, index) => {
      const bucket = firstBucket + index
      const sample = byBucket.get(bucket) || null
      return {
        bucketAt: bucket * HISTORY_SLOT_MS,
        observedAt: sample?.checkedAt || 0,
        state: sample?.state || 'missing',
        missing: !sample
      }
    })
  }

  const normalizeRow = (item) => {
    const checkedAt = Number(item?.checked_at)
    const checkedAtMs = checkedAt < 1e10 ? checkedAt * 1000 : checkedAt
    const stale = !Number.isFinite(checkedAtMs) || Date.now() - checkedAtMs > 45 * 60 * 1000
    const reportedState = stateLabels[String(item?.state || '').toLowerCase()]
      ? String(item.state).toLowerCase()
      : 'error'
    const state = stale ? 'stale' : reportedState
    const history = Array.isArray(item?.history)
      ? item.history
        .map(sample => {
          const rawTs = Number(sample?.checked_at)
          const sampleTs = rawTs < 1e10 ? rawTs * 1000 : rawTs
          const sampleState = String(sample?.state || 'error').toLowerCase()
          if (!Number.isFinite(sampleTs) || sampleTs <= 0) return null
          return {
            state: stateLabels[sampleState] ? sampleState : 'error',
            checkedAt: sampleTs
          }
        })
        .filter(Boolean)
        .sort((a, b) => a.checkedAt - b.checkedAt)
      : []
    const historySlots = buildHistorySlots(
      history,
      Number.isFinite(checkedAtMs) ? checkedAtMs : 0,
      reportedState
    )
    return {
      id: String(item?.id || ''),
      service: String(item?.service || ''),
      label: String(item?.label || item?.service || 'Service'),
      state,
      stateLabel: stateLabels[state] || stateLabels.error,
      message: String(item?.message || ''),
      checkedAt: Number.isFinite(checkedAtMs) ? checkedAtMs : 0,
      ageText: formatAge(checkedAtMs),
      history,
      historySlots
    }
  }

  const escapeHtml = (value) => String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')

  const render = (rows) => {
    if (!rows.length) {
      lastRenderKey = ''
      root.hidden = true
      root.innerHTML = ''
      return
    }

    const key = JSON.stringify(rows.map(item => [
      item.service,
      item.label,
      item.state,
      item.message,
      item.checkedAt,
      item.ageText,
      item.historySlots.map(slot => [slot.state, slot.observedAt])
    ]))
    if (key === lastRenderKey) return
    lastRenderKey = key

    const allOperational = rows.every(item => item.state === 'operational')
    const hardFailure = rows.some(item => ['unavailable', 'error', 'stale'].includes(item.state))
    const overallState = allOperational ? 'operational' : hardFailure ? 'unavailable' : 'degraded'
    const overallLabel = allOperational
      ? '所有服务正常'
      : hardFailure
        ? '存在服务异常'
        : '部分服务需要关注'

    root.innerHTML = `
      <section class="cfsm-service-status-panel" aria-label="服务状态">
        <header class="cfsm-service-status-header">
          <div>
            <h2 class="cfsm-service-status-title">服务状态</h2>
            <p class="cfsm-service-status-subtitle">最近一次健康检查 · ${rows.length} 个服务</p>
          </div>
          <div class="cfsm-service-status-overall" data-state="${overallState}">
            <span class="cfsm-service-status-dot"></span>
            <span>${overallLabel}</span>
          </div>
        </header>
        <div class="cfsm-service-status-list">
          ${rows.map(item => `
            <article class="cfsm-service-status-row">
              <div class="cfsm-service-status-row-top">
                <div class="cfsm-service-status-main">
                  <span class="cfsm-service-status-dot" data-state="${item.state}"></span>
                  <div class="cfsm-service-status-copy">
                    <div class="cfsm-service-status-name">${escapeHtml(item.label)}</div>
                    ${item.message ? `<div class="cfsm-service-status-message">${escapeHtml(item.message)}</div>` : ''}
                  </div>
                </div>
                <div class="cfsm-service-status-meta">
                  <span class="cfsm-service-status-state" data-state="${item.state}">${item.stateLabel}</span>
                  <span class="cfsm-service-status-age" title="${item.checkedAt ? new Date(item.checkedAt).toLocaleString() : ''}">${item.ageText}</span>
                </div>
              </div>
              <div class="cfsm-service-status-history-wrap">
                <div class="cfsm-service-status-history" aria-label="${escapeHtml(item.label)} 最近 24 小时检查历史，每 15 分钟一个点">
                  ${item.historySlots.map(slot => `
                    <span
                      class="cfsm-service-status-history-dot"
                      data-state="${slot.state}"
                      title="${slot.missing
                        ? `${escapeHtml(new Date(slot.bucketAt).toLocaleString())} · 无采样`
                        : `${escapeHtml(new Date(slot.observedAt).toLocaleString())} · ${stateLabels[slot.state] || stateLabels.error}`}"
                    ></span>
                  `).join('')}
                </div>
                <div class="cfsm-service-status-history-axis" aria-hidden="true">
                  <span>24 小时前</span>
                  <span>每 15 分钟</span>
                  <span>现在</span>
                </div>
              </div>
            </article>
          `).join('')}
        </div>
      </section>
    `
    root.hidden = !isPlacedInInstanceFlow
  }

  const fetchStatuses = async () => {
    const serverId = getServerId()
    if (!serverId) {
      activeServerId = ''
      render([])
      return
    }
    activeServerId = serverId
    try {
      const response = await fetch(`${getApiBase()}/api/service-status?id=${encodeURIComponent(serverId)}`, {
        credentials: 'include',
        headers: authHeaders(),
        cache: 'no-store'
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = await response.json()
      if (serverId !== activeServerId) return
      const services = Array.isArray(payload?.services)
        ? payload.services
        : Array.isArray(payload?.data?.services)
          ? payload.data.services
          : []
      render(services.map(normalizeRow))
    } catch {
      if (serverId === activeServerId) render([])
    }
  }

  const restoreRootToBody = () => {
    isPlacedInInstanceFlow = false
    root.hidden = true
    if (!document.body || root.parentElement === document.body) return
    const appRoot = document.getElementById('root')
    if (appRoot?.parentElement === document.body) {
      appRoot.insertAdjacentElement('afterend', root)
    } else {
      document.body.appendChild(root)
    }
  }

  const placeRootInInstanceFlow = (attempt = 0) => {
    if (placementTimer) {
      clearTimeout(placementTimer)
      placementTimer = 0
    }
    if (!getServerId()) return

    const backLink = document.querySelector('.instance-page-back')
    const instanceFlow = backLink?.parentElement
    if (instanceFlow) {
      if (root.parentElement !== instanceFlow) instanceFlow.appendChild(root)
      isPlacedInInstanceFlow = true
      root.hidden = !root.innerHTML
      return
    }

    // The instance page is lazy-loaded. Retry for up to one minute, but do
    // not observe/mutate the React tree continuously. Until placement
    // succeeds the body-level fallback root must remain hidden.
    isPlacedInInstanceFlow = false
    root.hidden = true
    if (attempt < 240) {
      placementTimer = window.setTimeout(() => {
        placementTimer = 0
        placeRootInInstanceFlow(attempt + 1)
      }, 250)
    }
  }

  const syncRoute = () => {
    const serverId = getServerId()
    if (!serverId) {
      activeServerId = ''
      lastRenderKey = ''
      render([])
      restoreRootToBody()
      return
    }
    placeRootInInstanceFlow()
    if (serverId === activeServerId) return
    activeServerId = serverId
    lastRenderKey = ''
    render([])
    void fetchStatuses()
  }

  const patchHistory = (name) => {
    const native = history[name]
    if (typeof native !== 'function') return
    history[name] = function (...args) {
      const result = native.apply(this, args)
      window.dispatchEvent(new Event('cfsm-routechange'))
      return result
    }
  }

  patchHistory('pushState')
  patchHistory('replaceState')
  window.addEventListener('hashchange', syncRoute)
  window.addEventListener('popstate', syncRoute)
  window.addEventListener('cfsm-routechange', syncRoute)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void fetchStatuses()
  }, { passive: true })

  syncRoute()
  refreshTimer = window.setInterval(() => {
    if (!document.hidden && getServerId()) void fetchStatuses()
  }, 60 * 1000)

  window.addEventListener('beforeunload', () => {
    if (refreshTimer) window.clearInterval(refreshTimer)
    if (placementTimer) window.clearTimeout(placementTimer)
  }, { once: true })
}
