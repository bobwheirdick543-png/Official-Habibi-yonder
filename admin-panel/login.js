// ============================================================
// Habibi Control — login page logic
// Lives only on login.html. On success, redirects to panel.html
// (a real page navigation, not a same-page hidden/unhidden swap).
// ============================================================

const gateForm = document.getElementById('gate-form')
const gateError = document.getElementById('gate-error')
const gateSubmit = document.getElementById('gate-submit')

gateForm.addEventListener('submit', async (e) => {
  e.preventDefault()
  gateError.hidden = true
  const url = document.getElementById('input-url').value.trim()
  const secret = document.getElementById('input-secret').value.trim()
  if (!url || !secret) return

  setGateLoading(true)
  session = { url, secret }
  try {
    await api('/ping')
    saveSession(session)
    location.href = 'panel.html'
  } catch (err) {
    session = null
    gateError.textContent = err.message.includes('fetch')
      ? "Couldn't reach that server. Check the URL and that it's running."
      : err.message
    gateError.hidden = false
    setGateLoading(false)
  }
})

function setGateLoading(loading) {
  gateSubmit.disabled = loading
  gateSubmit.querySelector('.btn-label').style.opacity = loading ? 0.5 : 1
  gateSubmit.querySelector('.btn-spinner').hidden = !loading
}

// ---------- boot ----------
// Already have a valid session? Skip the form entirely and go straight in.

;(function boot() {
  const saved = loadSession()
  if (!saved) return
  session = saved
  document.getElementById('input-url').value = saved.url
  setGateLoading(true)
  api('/ping')
    .then(() => { location.href = 'panel.html' })
    .catch(() => {
      session = null
      clearSession()
      setGateLoading(false)
    })
})()
