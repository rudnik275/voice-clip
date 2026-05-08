import { config } from './config'
import { runDailyCleanupIfNeeded, saveAudio } from './storage'
import { transcribeAudio } from './transcribe'
import { copyToClipboard } from './macos'
import { calcCostUsd } from './pricing'
import { createCostStore } from './cost-store'
import { createHistoryStore, type HistoryItem } from './history-store'
import indexPage from '../web/index.html'

const history = createHistoryStore(config.dataDir)
const costs = createCostStore(config.dataDir)

const SW_PATH = new URL('../web/sw.js', import.meta.url).pathname

function guessExt(mime: string): string {
  if (mime.includes('mp4') || mime.includes('m4a') || mime.includes('aac')) return '.m4a'
  if (mime.includes('webm')) return '.webm'
  if (mime.includes('ogg')) return '.ogg'
  if (mime.includes('wav')) return '.wav'
  if (mime.includes('mpeg') || mime.includes('mp3')) return '.mp3'
  return '.bin'
}

async function tlsOrNull(): Promise<{ cert: ReturnType<typeof Bun.file>; key: ReturnType<typeof Bun.file> } | undefined> {
  const certFile = Bun.file(config.certPath)
  const keyFile = Bun.file(config.keyPath)
  const haveBoth = (await certFile.exists()) && (await keyFile.exists())
  if (!haveBoth) {
    console.warn(
      `[tls] no cert at ${config.certPath} / ${config.keyPath} — starting HTTP. ` +
        `iPhone microphone will NOT work over HTTP. Run: bun run cert`,
    )
    return undefined
  }
  return { cert: certFile, key: keyFile }
}

export async function startServer() {
  const tls = await tlsOrNull()
  return Bun.serve({
    port: config.port,
    ...(tls ? { tls } : {}),
    routes: {
      '/': indexPage,
      '/sw.js': () =>
        new Response(Bun.file(SW_PATH), {
          headers: {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Service-Worker-Allowed': '/',
            'Cache-Control': 'no-cache',
          },
        }),
      '/cost': async () => Response.json(await costs.get()),
      '/history': {
        GET: async () => Response.json(await history.list()),
        DELETE: async () => {
          const removed = await history.clear()
          return Response.json({ removed })
        },
      },
      '/history/read-all': {
        POST: async () => {
          const updated = await history.markAllRead()
          return Response.json({ updated })
        },
      },
      '/history/:id': {
        DELETE: async (req) => {
          const id = req.params.id
          const ok = await history.remove(id)
          return Response.json({ ok }, { status: ok ? 200 : 404 })
        },
      },
      '/history/:id/read': {
        POST: async (req) => {
          const id = req.params.id
          const item = await history.markRead(id)
          return item ? Response.json(item) : Response.json({ error: 'not found' }, { status: 404 })
        },
      },
      '/upload': {
        POST: async (req) => {
          try {
            await runDailyCleanupIfNeeded()
            const form = await req.formData()
            const audio = form.get('audio')
            if (!(audio instanceof Blob)) {
              return Response.json({ error: 'no audio field' }, { status: 400 })
            }
            const sourceField = form.get('source')
            const source: 'online' | 'offline' = sourceField === 'offline' ? 'offline' : 'online'
            const recordedAtField = form.get('recordedAt')
            const recordedAt = typeof recordedAtField === 'string' ? recordedAtField : undefined

            const buf = new Uint8Array(await audio.arrayBuffer())
            const ext = guessExt(audio.type)
            const { base } = await saveAudio(buf, ext)

            const result = await transcribeAudio(buf, `voice${ext}`)
            const text = result.text.trim()

            let costUsd: number | undefined
            let totalUsd: number | undefined
            let totalRequests: number | undefined
            if (result.usage) {
              costUsd = calcCostUsd(result.usage)
              const state = await costs.record(costUsd)
              totalUsd = state.totalUsd
              totalRequests = state.totalRequests
            }

            const ts = new Date().toISOString()
            if (text) {
              const item: HistoryItem = {
                id: base,
                ts,
                ...(recordedAt ? { recordedAt } : {}),
                text,
                ...(costUsd !== undefined ? { costUsd } : {}),
                source,
                // Online recordings are auto-read: only offline items surface as unread
                // (something the user hasn't seen the result of yet).
                ...(source === 'online' ? { readAt: ts } : {}),
              }
              await history.append(item)
              if (source === 'online') {
                await copyToClipboard(text).catch((err) => {
                  console.error('[upload] pbcopy failed:', err)
                })
              }
            }

            console.log(
              `[upload] ${base}${ext} (${source}) → ${text.length} chars` +
                (costUsd !== undefined ? ` · $${costUsd.toFixed(5)} (total $${totalUsd?.toFixed(4)})` : ''),
            )
            return Response.json({ id: base, text, costUsd, totalUsd, totalRequests, source })
          } catch (err) {
            console.error('[upload] error:', err)
            const msg = err instanceof Error ? err.message : 'internal error'
            return Response.json({ error: msg }, { status: 500 })
          }
        },
      },
    },
  })
}
