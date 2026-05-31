import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'

// Global Neo-Brutalism stylesheet, carried over 1:1 from the old shell
// (design tokens, dot-grid, mechanical press, voice halo vars). Vite
// bundles + content-hashes it.
import '../style.css'

const app = createApp(App)
app.use(createPinia())
app.mount('#app')
