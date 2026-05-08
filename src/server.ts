import { config } from './config'
import { createAudioStorage, type AudioStorage } from './storage'
import { transcribeAudio } from './transcribe'
import { copyToClipboard } from './macos'
import { calcCostUsd } from './pricing'
import { createCostStore, type CostStore } from './cost-store'
import { createHistoryStore, type HistoryItem, type HistoryStore } from './history-store'
import indexPage from '../web/index.html'
import offlinePage from '../web/offline.html'

const SW_PATH = new URL('../web/sw.js', import.meta.url).pathname

export interface ServerDeps {
  history?: HistoryStore
  costs?: CostStore
  audio?: AudioStorage
  transcribe?: typeof transcribeAudio
  copyToClipboard?: typeof copyToClipboard
  port?: number
  certPath?: string
  keyPath?: string
  useTls?: boolean
}

function guessExt(mime: string): string {
  if (mime.includes('mp4') || mime.includes('m4a') || mime.includes('aac')) return '.m4a'
  if (mime.includes('webm')) return '.webm'
  if (mime.includes('ogg')) return '.ogg'
  if (mime.includes('wav')) return '.wav'
  if (mime.includes('mpeg') || mime.includes('mp3')) return '.mp3'
  return '.bin'
}

async function tlsOrNull(
  certPath: string,
  keyPath: string,
): Promise<{ cert: ReturnType<typeof Bun.file>; key: ReturnType<typeof Bun.file> } | undefined> {
  const certFile = Bun.file(certPath)
  const keyFile = Bun.file(keyPath)
  const haveBoth = (await certFile.exists()) && (await keyFile.exists())
  if (!haveBoth) {
    console.warn(
      `[tls] no cert at ${certPath} / ${keyPath} — starting HTTP. ` +
        `iPhone microphone will NOT work over HTTP. Run: bun run cert`,
    )
    return undefined
  }
  return { cert: certFile, key: keyFile }
}

export async function startServer(deps: ServerDeps = {}) {
  const history = deps.history ?? createHistoryStore(config.dataDir)
  const costs = deps.costs ?? createCostStore(config.dataDir)
  const audio = deps.audio ?? createAudioStorage(config.dataDir)
  const transcribe = deps.transcribe ?? transcribeAudio
  const copy = deps.copyToClipboard ?? copyToClipboard
  const port = deps.port ?? config.port
  const certPath = deps.certPath ?? config.certPath
  const keyPath = deps.keyPath ?? config.keyPath
  const useTls = deps.useTls ?? true

  const tls = useTls ? await tlsOrNull(certPath, keyPath) : undefined

  return Bun.serve({
    port,
    ...(tls ? { tls } : {}),
    routes: {
      '/': indexPage,
      '/offline': offlinePage,
      '/sw.js': () =>
        new Response(Bun.file(SW_PATH), {
          headers: {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Service-Worker-Allowed': '/',
            'Cache-Control': 'no-cache',
          },
        }),
      '/version': () =>
        new Response('v7', {
          headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' },
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
            await audio.runDailyCleanupIfNeeded()
            const form = await req.formData()
            const audioBlob = form.get('audio')
            if (!(audioBlob instanceof Blob)) {
              return Response.json({ error: 'no audio field' }, { status: 400 })
            }
            const sourceField = form.get('source')
            const source: 'online' | 'offline' = sourceField === 'offline' ? 'offline' : 'online'
            const recordedAtField = form.get('recordedAt')
            const recordedAt = typeof recordedAtField === 'string' ? recordedAtField : undefined

            const buf = new Uint8Array(await audioBlob.arrayBuffer())
            const ext = guessExt(audioBlob.type)
            const { base } = await audio.saveAudio(buf, ext)

            const result = await transcribe(buf, `voice${ext}`)
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
                await copy(text).catch((err) => {
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
