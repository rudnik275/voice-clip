import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// Vite project root is web/. `vite build` emits web/dist/ which the Bun
// server (src/server.ts) serves as static files + index.html at `/`.
// Assets are content-hashed by Vite, replacing the old manual ASSET_VER
// dance + Bun.build(app.ts) bundling. See docs/adr/0006.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: '/',
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsDir: 'assets',
    rollupOptions: {
      output: {
        // Content-hashed filenames for cache-busting (the cache-control:
        // immutable headers the server sets are safe because the hash
        // changes whenever the bytes change).
        entryFileNames: 'assets/[name].[hash].js',
        chunkFileNames: 'assets/[name].[hash].js',
        assetFileNames: 'assets/[name].[hash].[ext]',
      },
    },
  },
})
