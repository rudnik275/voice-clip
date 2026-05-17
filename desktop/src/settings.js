// Voice Clip desktop — Settings webview (plain JS, NO TypeScript).
// Manages the autostart toggle by invoking Rust commands.

const { invoke } = window.__TAURI__.core

const toggle = document.getElementById('autostart-toggle')

async function init() {
  try {
    const enabled = await invoke('autostart_enabled')
    toggle.checked = !!enabled
  } catch (e) {
    console.error('autostart_enabled failed', e)
  }
}

toggle.addEventListener('change', async () => {
  const want = toggle.checked
  try {
    if (want) {
      await invoke('enable_autostart')
    } else {
      await invoke('disable_autostart')
    }
  } catch (e) {
    console.error('autostart toggle failed', e)
    // Revert on error.
    toggle.checked = !want
  }
})

init()
