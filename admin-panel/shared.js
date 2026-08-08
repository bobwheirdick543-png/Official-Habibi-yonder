// ============================================================
// Habibi Control — shared code
// Loaded by both login.html and panel.html: session storage,
// the /api client, toasts, and formatting helpers.
// ============================================================

const STORAGE_KEY = 'habibi-panel-session'

let session = null // { url, secret }

// ---------- storage ----------

function loadSession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function saveSession(s) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
}

function clearSession() {
  localStorage.removeItem(STORAGE_KEY)
}

// ---------- API client ----------

function apiUrl(path) {
  return session.url.replace(/\/+$/, '') + '/api' + path
}

async function api(path, options = {}) {
  const res = await fetch(apiUrl(path), {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'x-admin-secret': session.secret,
      ...(options.headers || {})
    }
  })

  if (res.status === 401) {
    clearSession()
    session = null
    if (!location.pathname.endsWith('login.html')) {
      location.href = 'login.html'
    }
    throw new Error('Session expired — sign in again.')
  }

  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`)
  return data
}

const get = (path) => api(path)
const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body || {}) })
const put = (path, body) => api(path, { method: 'PUT', body: JSON.stringify(body || {}) })
const del = (path) => api(path, { method: 'DELETE' })

// ---------- toasts ----------

function toast(message, kind = 'ok') {
  const stack = document.getElementById('toast-stack')
  const el = document.createElement('div')
  el.className = `toast ${kind}`
  el.textContent = message
  stack.appendChild(el)
  setTimeout(() => el.remove(), 4200)
}

// ---------- formatting ----------

function fmtHabz(n) {
  const num = Number(n || 0)
  if (Math.abs(num) >= 1_000_000) return (num / 1_000_000).toFixed(2).replace(/\.00$/, '') + 'M'
  if (Math.abs(num) >= 1_000) return (num / 1_000).toFixed(1).replace(/\.0$/, '') + 'K'
  return num.toLocaleString()
}

function fmtUptime(seconds) {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h > 0) return `${h}h ${m}m up`
  return `${m}m up`
}

function timeAgo(iso) {
  if (!iso) return ''
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function timeUntil(iso) {
  if (!iso) return ''
  const diff = new Date(iso).getTime() - Date.now()
  if (diff <= 0) return 'any moment'
  const mins = Math.ceil(diff / 60000)
  if (mins < 60) return `in ${mins}m`
  const hrs = Math.floor(mins / 60)
  const remMins = mins % 60
  return `in ${hrs}h ${remMins}m`
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
