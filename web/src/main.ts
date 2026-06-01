import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'

// Global Neo-Brutalism stylesheet, carried over 1:1 from the old shell
// (design tokens, dot-grid, mechanical press, voice halo vars). Vite
// bundles + content-hashes it.
import '../style.css'

// Tauri shell adapter. Imported for its side effects and BEFORE the app
// mounts: in the desktop webview it (a) monkey-patches window.fetch to point
// relative API calls at the server + attach the Keychain device token, and
// (b) shows the #tauri-pair splash when unpaired. Must run before App.vue's
// onMounted → session.load() fires the first fetch('/me'). A no-op in the PWA
// (window.__TAURI__ is undefined), so it costs nothing in the browser bundle.
import '../tauri-runtime'

const app = createApp(App)
app.use(createPinia())
app.mount('#app')
