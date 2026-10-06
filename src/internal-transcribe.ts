// Internal transcription endpoint for sibling services on the VPS — today the
// family-budget Telegram bot, which turns family voice messages into text.
//
// It listens on its OWN port (INTERNAL_TRANSCRIBE_PORT) that no Cloudflare
// Tunnel ingress publishes and that is not bound on the host: only containers
// on the docker network `infra-net` can reach `voice-clip:<port>`. That network
// boundary is the auth — there is no shared secret to keep in two vaults.
//
// Deliberately side-effect free: no user, no history, no clipboard fan-out, no
// quota. It only reuses `transcribeAudio`; the cost of each call is logged so
// it shows up in `docker logs voice-clip`.
//
//   POST /transcribe   multipart: audio (file, ≤ 5 MB)
//   200 {text, costUsd} · 400 bad form · 413 too large · 502 transcription failed

import { extname } from 'node:path'
import { calcCostUsd } from './pricing'
import type { TranscriptionResult } from './transcribe'

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024

export interface InternalTranscribeOptions {
  port: number
  transcribe: (input: Uint8Array, filename: string) => Promise<TranscriptionResult>
  maxBytes?: number
  log?: (msg: string) => void
}

// Telegram voice notes arrive as `.oga`/`.opus`; OpenAI only accepts the same
// OGG bytes labelled `.ogg` (see telegramFilename, #159).
export function internalFilename(name: string | undefined): string {
  let ext = extname(name ?? '').toLowerCase()
  if (ext === '.oga' || ext === '.opus') ext = '.ogg'
  return `clip${ext || '.ogg'}`
}

export function startInternalTranscribeServer(opts: InternalTranscribeOptions) {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  const log = opts.log ?? ((msg: string) => console.log(msg))
  return Bun.serve({
    port: opts.port,
    // Up to a 5 MB clip plus the multipart envelope.
    maxRequestBodySize: maxBytes + 64 * 1024,
    async fetch(req) {
      const { pathname } = new URL(req.url)
      if (pathname !== '/transcribe') return new Response('Not Found', { status: 404 })
      if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })

      let form: Awaited<ReturnType<Request['formData']>>
      try {
        form = await req.formData()
      } catch {
        return Response.json({ error: 'expected multipart/form-data' }, { status: 400 })
      }
      const audio = form.get('audio')
      if (!(audio instanceof Blob)) return Response.json({ error: 'missing audio field' }, { status: 400 })
      const bytes = new Uint8Array(await audio.arrayBuffer())
      if (bytes.length > maxBytes) {
        return Response.json({ error: 'clip too long', bytes: bytes.length, limit: maxBytes }, { status: 413 })
      }

      const filename = internalFilename((audio as File).name)
      try {
        const result = await opts.transcribe(bytes, filename)
        const costUsd = result.usage ? calcCostUsd(result.usage) : 0
        log(`[internal-transcribe] ok bytes=${bytes.length} chars=${result.text.length} cost=$${costUsd.toFixed(5)}`)
        return Response.json({ text: result.text, costUsd })
      } catch (e) {
        const msg = (e as Error).message
        log(`[internal-transcribe] failed bytes=${bytes.length} file=${filename}: ${msg}`)
        return Response.json({ error: `transcription failed: ${msg}` }, { status: 502 })
      }
    },
  })
}
