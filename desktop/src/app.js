// Voice Clip desktop — webview view layer (plain JS, NO TypeScript).
//
// This file is intentionally thin: all security-relevant logic (one-time
// state validation, Keychain, SSE, pbcopy) lives in Rust (src-tauri). The
// webview only renders the two views and forwards two user intents
// (sign in / sign out) to Rust commands.

const { invoke } = window.__TAURI__.core
const { listen } = window.__TAURI__.event

const $ = (id) => document.getElementById(id)

const views = {
  signedOut: $('signed-out'),
  signedIn: $('signed-in'),
}

function show(which) {
  views.signedOut.hidden = which !== 'signedOut'
  views.signedIn.hidden = which !== 'signedIn'
}

const STATUS = {
  connecting: { label: 'Connecting…', cls: 'connecting' },
  connected: { label: 'Connected', cls: 'connected' },
  reconnecting: { label: 'Reconnecting…', cls: 'reconnecting' },
  offline: { label: 'Offline', cls: 'offline' },
}

function renderStatus(name) {
  const s = STATUS[name] || STATUS.offline
  const dot = $('status-dot')
  dot.className = 'dot ' + s.cls
  $('status-text').textContent = s.label
}

async function refresh() {
  const paired = await invoke('is_paired')
  show(paired ? 'signedIn' : 'signedOut')
  if (paired) renderStatus('connecting')
}

$('sign-in').addEventListener('click', async () => {
  const btn = $('sign-in')
  btn.disabled = true
  btn.textContent = 'Opening browser…'
  try {
    const url = await invoke('begin_pairing')
    const link = $('pairing-link')
    link.href = url
    $('pairing-hint').hidden = false
  } catch (e) {
    $('pairing-hint').hidden = false
    console.error('begin_pairing failed', e)
  } finally {
    btn.disabled = false
    btn.textContent = 'Sign in with Google'
  }
})

$('pairing-link').addEventListener('click', (ev) => {
  // The href is the real pairing URL; let the OS open it in the browser.
  ev.preventDefault()
  window.open($('pairing-link').href, '_blank')
})

$('sign-out').addEventListener('click', async () => {
  await invoke('sign_out')
  show('signedOut')
})

// Rust → webview events.
listen('status', (e) => renderStatus(e.payload.status))

listen('clip', (e) => {
  const t = (e.payload && e.payload.text) || ''
  $('last-clip').textContent = t.length ? t : '— (empty) —'
})

listen('paired', async () => {
  await refresh()
})

refresh()
