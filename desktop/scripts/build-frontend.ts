// Build the Tauri webview frontend = the Vue/Vite SPA, adapted for the macOS
// desktop shell. Same web/ sources drive both the PWA and the desktop app
// (ADR 0006): here we run the production `vite build`, then drop the result
// into desktop/src-tauri/dist/ (tauri.conf.json's `frontendDist`) plus the two
// desktop-only settings-window files.
//
// (Pre-Vue this script hand-bundled web/app.ts + home.html via Bun.build; both
// were deleted in #106, so the desktop frontend now comes straight from Vite.)
//
// Asset paths: vite emits absolute /assets/<hashed> URLs. Tauri serves
// frontendDist at the custom-protocol root, so those resolve in the webview.
// App-level API calls (fetch('/me')) are rewritten to the server origin at
// runtime by web/tauri-runtime.ts (imported early in web/src/main.ts), which
// also drives the #tauri-pair splash baked into web/index.html.

import { cp, mkdir, rm } from 'node:fs/promises'
import { $ } from 'bun'

const REPO = new URL('../../', import.meta.url).pathname
const OUT = `${REPO}desktop/src-tauri/dist`

// 1. Production Vue build → web/dist (content-hashed assets + index.html, which
//    carries the #tauri-pair splash markup the desktop shell needs). Run from
//    the repo root so vite finds web/vite.config.ts + node_modules. Bun.$
//    throws on a non-zero exit, so a failed build fails the tauri build.
await $`bun run build:web`.cwd(REPO)

// 2. Replace the desktop dist with the fresh web build.
await rm(OUT, { recursive: true, force: true })
await mkdir(OUT, { recursive: true })
await cp(`${REPO}web/dist`, OUT, { recursive: true })

// 3. Settings window — a SEPARATE Tauri webview opened from the tray menu, not
//    part of the SPA bundle. It's plain HTML/JS referencing style.css at the
//    dist root, so copy all three verbatim.
await cp(`${REPO}web/style.css`, `${OUT}/style.css`)
await cp(`${REPO}desktop/src/settings.html`, `${OUT}/settings.html`)
await cp(`${REPO}desktop/src/settings.js`, `${OUT}/settings.js`)

console.log(`✓ desktop frontend built → ${OUT}`)
