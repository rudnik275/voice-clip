// Build the Tauri webview frontend by bundling the PWA sources in web/.
// Same code, two shells — keeps PWA and macOS app behaviour identical
// without forking the UI. Output lands in desktop/src-tauri/dist/ which
// tauri.conf.json declares as `frontendDist`.

import { cp, mkdir, rm, writeFile } from 'node:fs/promises'
import { APP_VERSION } from '../../src/version'

const REPO = new URL('../../', import.meta.url).pathname
const OUT = `${REPO}desktop/src-tauri/dist`

await rm(OUT, { recursive: true, force: true })
await mkdir(OUT, { recursive: true })

// Bundle web/app.ts → dist/app.js. Same Bun.build invocation the server
// runs at boot for the PWA — including sounds.ts via its import graph.
const built = await Bun.build({
  entrypoints: [`${REPO}web/app.ts`],
  target: 'browser',
  minify: true,
})
if (!built.success) {
  console.error('bun build failed:')
  for (const log of built.logs) console.error(log)
  process.exit(1)
}
const appJs = await built.outputs[0]!.text()
await writeFile(`${OUT}/app.js`, appJs)

// Style sheet — copy verbatim, no rewriting (the tokens + brutalism are
// intentionally identical to the PWA).
await cp(`${REPO}web/style.css`, `${OUT}/style.css`)

// Tauri-only views (settings window). The main webview loads index.html;
// this is opened from the tray menu via `open_settings`. Same brutalism
// tokens via the shared style.css above.
await cp(`${REPO}desktop/src/settings.html`, `${OUT}/settings.html`)
await cp(`${REPO}desktop/src/settings.js`, `${OUT}/settings.js`)

// Adapt home.html for the Tauri webview:
//   - drop PWA-only chrome (manifest, icons, service worker registration)
//   - relative paths instead of absolute (the webview's asset:// protocol
//     resolves them off the bundled dist dir, not a server root)
//   - swap the modulepreload + <script src="/app.ts"> for the pre-built
//     app.js artifact we just wrote
//   - stamp the version string the PWA's server normally substitutes
let html = await Bun.file(`${REPO}web/home.html`).text()
html = html
  .replace(/^\s*<link rel="manifest"[^>]*>\s*$/gm, '')
  .replace(/^\s*<link rel="(icon|apple-touch-icon)"[^>]*>\s*$/gm, '')
  .replace(/<script>[\s\S]*?serviceWorker[\s\S]*?<\/script>/g, '')
  .replace(/<link rel="modulepreload"[^>]*\/app\.ts"\s*\/?>/g, '')
  .replace(
    /<script type="module" src="\/app\.ts"><\/script>/g,
    '<script type="module" src="app.js"></script>',
  )
  .replaceAll('"/style.css"', '"style.css"')
  .replaceAll('__APP_VERSION__', APP_VERSION)
await writeFile(`${OUT}/index.html`, html)

console.log(`✓ desktop frontend built → ${OUT}`)
console.log(`  app.js     ${(appJs.length / 1024).toFixed(1)} KiB`)
console.log(`  index.html ${(html.length / 1024).toFixed(1)} KiB`)
