#!/usr/bin/env bun
// voice-clip-daemon — long-running per-user worker on the user's Mac.
// Holds an SSE connection to the server and pbcopy's every transcript that
// lands in their account, so Cmd+V on the Mac always has the latest clip.
//
// Required env: VOICE_CLIP_URL, VOICE_CLIP_TOKEN. Set by launchd plist.

const URL = process.env.VOICE_CLIP_URL ?? ''
const TOKEN = process.env.VOICE_CLIP_TOKEN ?? ''

if (!URL || !TOKEN) {
  console.error('[voice-clip-daemon] missing VOICE_CLIP_URL or VOICE_CLIP_TOKEN env vars')
  process.exit(2)
}

async function pbcopy(text: string): Promise<void> {
  const proc = Bun.spawn(['pbcopy'], { stdin: 'pipe' })
  proc.stdin.write(text)
  await proc.stdin.end()
  const code = await proc.exited
  if (code !== 0) throw new Error(`pbcopy exited ${code}`)
}

async function ack(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  await fetch(`${URL}/events/ack`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Daemon-Token': TOKEN,
    },
    body: JSON.stringify({ ids }),
  }).catch((err) => {
    // Best-effort: a failed ACK just means the clip will replay on reconnect.
    console.warn('[voice-clip-daemon] ack failed:', err)
  })
}

async function streamOnce(): Promise<void> {
  const res = await fetch(`${URL}/events?token=${encodeURIComponent(TOKEN)}`, {
    headers: { Accept: 'text/event-stream' },
  })
  if (!res.ok || !res.body) {
    throw new Error(`stream HTTP ${res.status}`)
  }
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) return
    buf += dec.decode(value, { stream: true })
    const parts = buf.split('\n\n')
    buf = parts.pop() ?? ''
    for (const block of parts) {
      const trimmed = block.trim()
      if (!trimmed || trimmed.startsWith(':')) continue // keepalive comment
      const dataLine = trimmed.replace(/^data:\s*/m, '')
      try {
        const clip = JSON.parse(dataLine) as { id: string; text: string }
        await pbcopy(clip.text)
        // Ack each clip individually — keeps the server's pending queue tight.
        // Don't await: pbcopy is the user-visible action; ACK is bookkeeping.
        void ack([clip.id])
        console.log(`[voice-clip-daemon] copied ${clip.id} (${clip.text.length} chars)`)
      } catch (err) {
        console.error('[voice-clip-daemon] handle clip failed:', err)
      }
    }
  }
}

async function loop(): Promise<void> {
  console.log(`[voice-clip-daemon] starting; url=${URL}`)
  // Reconnect with capped exponential backoff.
  let backoff = 1000
  while (true) {
    try {
      await streamOnce()
      console.warn('[voice-clip-daemon] stream ended, reconnecting…')
      backoff = 1000
    } catch (err) {
      console.warn(`[voice-clip-daemon] connection error (retry in ${backoff}ms):`, err)
    }
    await new Promise((r) => setTimeout(r, backoff))
    backoff = Math.min(backoff * 2, 30_000)
  }
}

void loop()
