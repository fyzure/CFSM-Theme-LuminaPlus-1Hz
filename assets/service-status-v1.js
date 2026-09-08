const root = document.getElementById('cfsm-service-status-root')

if (root) {
  const stateLabels = {
    operational: '运行正常',
    degraded: '性能下降',
    unavailable: '不可用',
    maintenance: '维护中',
    auth_required: '需要登录',
    error: '检查异常',
    stale: '状态过期'
  }

  let activeServerId = ''
  let refreshTimer = null
  let lastRenderKey = ''

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

  const normalizeRow = (item) => {
    const checkedAt = Number(item?.checked_at)
    const checkedAtMs = checkedAt < 1e10 ? checkedAt * 1000 : checkedAt
    const stale = !Number.isFinite(checkedAtMs) || Date.now() - checkedAtMs > 45 * 60 * 1000
    const state = stale ? 'stale' : String(item?.state || 'error').toLowerCase()
    return {
      id: String(item?.id || ''),
      service: String(item?.service || ''),
      label: String(item?.label || item?.service || 'Service'),
      state,
      stateLabel: stateLabels[state] || stateLabels.error,
      message: String(item?.message || ''),
      checkedAt: Number.isFinite(checkedAtMs) ? checkedAtMs : 0,
      ageText: formatAge(checkedAtMs)
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
      item.ageText
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
            </article>
          `).join('')}
        </div>
      </section>
    `
    root.hidden = false
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

  const syncRoute = () => {
    const serverId = getServerId()
    if (serverId === activeServerId && serverId) return
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
  }, { once: true })
}
