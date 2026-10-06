import { test, expect, afterEach } from 'bun:test'
import { internalFilename, startInternalTranscribeServer } from '../src/internal-transcribe'
import type { TranscriptionResult } from '../src/transcribe'

let server: ReturnType<typeof startInternalTranscribeServer> | undefined
afterEach(() => {
  server?.stop(true)
  server = undefined
})

function start(transcribe: (input: Uint8Array, filename: string) => Promise<TranscriptionResult>, maxBytes?: number) {
  const logs: string[] = []
  server = startInternalTranscribeServer({ port: 0, transcribe, maxBytes, log: (m) => logs.push(m) })
  return { base: `http://localhost:${server.port}`, logs }
}

function upload(base: string, bytes: Uint8Array, name: string) {
  const form = new FormData()
  form.append('audio', new File([bytes], name, { type: 'audio/ogg' }))
  return fetch(`${base}/transcribe`, { method: 'POST', body: form })
}

test('Telegram .oga is renamed to .ogg before transcription', () => {
  expect(internalFilename('file_12.oga')).toBe('clip.ogg')
  expect(internalFilename('voice.OPUS')).toBe('clip.ogg')
  expect(internalFilename('note.m4a')).toBe('clip.m4a')
  expect(internalFilename(undefined)).toBe('clip.ogg')
})

test('returns the transcript and its cost, with no user or history involved', async () => {
  const calls: Array<{ bytes: number; filename: string }> = []
  const { base, logs } = start(async (input, filename) => {
    calls.push({ bytes: input.length, filename })
    return { text: '300 такси', usage: { audioTokens: 1000, textTokens: 0, outputTokens: 10 } }
  })
  const res = await upload(base, new Uint8Array([1, 2, 3]), 'file_7.oga')
  expect(res.status).toBe(200)
  const body = (await res.json()) as { text: string; costUsd: number }
  expect(body.text).toBe('300 такси')
  expect(body.costUsd).toBeGreaterThan(0)
  expect(calls).toEqual([{ bytes: 3, filename: 'clip.ogg' }])
  expect(logs[0]).toContain('[internal-transcribe] ok bytes=3')
})

test('rejects a clip over the size limit without calling OpenAI', async () => {
  let called = false
  const { base } = start(async () => {
    called = true
    return { text: '' }
  }, 4)
  const res = await upload(base, new Uint8Array(10), 'big.ogg')
  expect(res.status).toBe(413)
  expect(called).toBe(false)
})

test('bad requests: missing audio, wrong method, unknown path', async () => {
  const { base } = start(async () => ({ text: '' }))
  const form = new FormData()
  form.append('note', 'no audio here')
  expect((await fetch(`${base}/transcribe`, { method: 'POST', body: form })).status).toBe(400)
  expect((await fetch(`${base}/transcribe`)).status).toBe(405)
  expect((await fetch(`${base}/upload`, { method: 'POST' })).status).toBe(404)
})

test('a transcription failure is a 502 with the reason', async () => {
  const { base } = start(async () => {
    throw new Error('400 Unsupported file format')
  })
  const res = await upload(base, new Uint8Array([1]), 'x.ogg')
  expect(res.status).toBe(502)
  expect(((await res.json()) as { error: string }).error).toContain('Unsupported file format')
})
