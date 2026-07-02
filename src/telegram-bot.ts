// Standalone Telegram transcription bot — a personal, owner-only convenience
// relay: forward a voice/audio message to the bot and it replies with the
// transcript as a tap-to-copy code block.
//
// Deliberately STANDALONE: no DB, no history, no cost tracking, no clipboard
// fan-out to paired Macs. It only reuses `transcribeAudio` (OpenAI
// gpt-4o-transcribe). This is the "телеграм бот только для меня" ask — a way to
// paste in a voice and get faithful text back without hand-typing.
//
// Owner lock: the bot answers only Telegram user IDs listed in
// TELEGRAM_ALLOWED_USER_IDS. With an EMPTY allowlist it runs in "setup mode" —
// it replies to anyone with their own Telegram ID so the owner can grab it and
// fill the env var (nobody else knows the private bot handle).
//
// Transport: raw Telegram Bot API over `fetch` (long-polling getUpdates). No
// `grammy`/`node-telegram-bot-api` dependency — Bun's global fetch is enough.
//
// Launched from src/index.ts when TELEGRAM_BOT_TOKEN is set; runs alongside the
// HTTP server as a background poll loop.

import { extname } from 'node:path'
import type { TranscriptionResult } from './transcribe'

// ─── Telegram wire types (only the fields we touch) ─────────────────────────

export interface TgUser {
  id: number
  username?: string
  first_name?: string
}

interface TgFileRef {
  file_id: string
  mime_type?: string
  file_name?: string
}

export interface TgMessage {
  message_id: number
  from?: TgUser
  chat: { id: number }
  voice?: TgFileRef
  audio?: TgFileRef
  video_note?: TgFileRef
  document?: TgFileRef
  text?: string
}

export interface TgUpdate {
  update_id: number
  message?: TgMessage
}

// The network surface the handler depends on — stubbed in tests.
export interface TelegramApi {
  getUpdates(offset: number, timeoutSec: number): Promise<TgUpdate[]>
  getFilePath(fileId: string): Promise<string>
  downloadFile(filePath: string): Promise<Uint8Array>
  sendMessage(chatId: number, html: string, replyToMessageId?: number): Promise<void>
  sendChatAction(chatId: number, action: string): Promise<void>
}

export type TranscribeFn = (input: Uint8Array, filename: string) => Promise<TranscriptionResult>

export interface HandlerDeps {
  api: TelegramApi
  transcribe: TranscribeFn
  allowedUserIds: Set<number>
}

// Telegram hard-caps a message at 4096 chars; we wrap in <code>…</code> and
// leave head-room for the tags + any HTML-escape expansion.
const TELEGRAM_TEXT_LIMIT = 3500

// ─── Pure helpers (exported for unit tests) ─────────────────────────────────

export function parseTelegramUserIds(raw: string | undefined): Set<number> {
  const ids = new Set<number>()
  if (!raw) return ids
  for (const part of raw.split(',')) {
    const n = Number(part.trim())
    if (Number.isInteger(n) && n !== 0) ids.add(n)
  }
  return ids
}

// Escape the three characters that are special inside Telegram HTML parse mode.
// Inside <code> that is all that's required (unlike MarkdownV2's long list).
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Split a long transcript into Telegram-sized chunks, preferring to break on a
// newline or space boundary so words aren't cut mid-token.
export function chunkForTelegram(text: string, limit = TELEGRAM_TEXT_LIMIT): string[] {
  if (text.length <= limit) return [text]
  const chunks: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit)
    if (cut < limit * 0.5) cut = rest.lastIndexOf(' ', limit)
    if (cut < limit * 0.5) cut = limit
    chunks.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  if (rest.length > 0) chunks.push(rest)
  return chunks
}

// Choose a filename whose extension OpenAI can map to a supported format. The
// extension is the ONLY mime signal transcribeAudio passes through.
//
// Telegram voice notes arrive as `.oga` (OGG/Opus), but OpenAI's transcription
// endpoint rejects the `.oga`/`.opus` extension variants with
// `400 Unsupported file format oga` even though the bytes are ordinary OGG —
// it only accepts `.ogg`. Same container, different label, so normalizing the
// extension is enough (no transcode needed).
export function telegramFilename(filePath: string, msg: TgMessage): string {
  let ext = extname(filePath).toLowerCase()
  if (ext === '.oga' || ext === '.opus') ext = '.ogg'
  if (ext) return `clip${ext}`
  if (msg.voice) return 'clip.ogg'
  if (msg.video_note) return 'clip.mp4'
  if (msg.audio) return msg.audio.file_name ?? 'clip.mp3'
  return 'clip.ogg'
}

function pickMedia(msg: TgMessage): TgFileRef | undefined {
  if (msg.voice) return msg.voice
  if (msg.audio) return msg.audio
  if (msg.video_note) return msg.video_note
  // Audio sent "as a file" arrives as a document with an audio/* mime type.
  if (msg.document && msg.document.mime_type?.startsWith('audio/')) return msg.document
  return undefined
}

// ─── Message handler ────────────────────────────────────────────────────────

export async function handleMessage(msg: TgMessage, deps: HandlerDeps): Promise<void> {
  const from = msg.from
  if (!from) return

  // Setup mode: no allowlist configured yet → help the owner discover their ID.
  if (deps.allowedUserIds.size === 0) {
    await deps.api.sendMessage(
      msg.chat.id,
      '👋 Бот запущен, но список разрешённых пользователей пуст.\n' +
        `Твой Telegram ID: <code>${from.id}</code>\n` +
        'Добавь его в TELEGRAM_ALLOWED_USER_IDS и перезапусти сервер.',
      msg.message_id,
    )
    return
  }

  // Owner lock — ignore everyone else silently (don't leak that the bot exists).
  if (!deps.allowedUserIds.has(from.id)) {
    console.log(`[telegram] ignored user ${from.id} (@${from.username ?? '—'})`)
    return
  }

  const media = pickMedia(msg)
  if (!media) {
    await deps.api.sendMessage(
      msg.chat.id,
      'Перешли или запиши голосовое сообщение — верну расшифровку текстом, готовым к копированию.',
      msg.message_id,
    )
    return
  }

  await deps.api.sendChatAction(msg.chat.id, 'typing').catch(() => {})

  let bytes: Uint8Array
  let filename: string
  try {
    const filePath = await deps.api.getFilePath(media.file_id)
    bytes = await deps.api.downloadFile(filePath)
    filename = telegramFilename(filePath, msg)
  } catch (e) {
    console.error('[telegram] download error:', e)
    await deps.api.sendMessage(msg.chat.id, '⚠️ Не смог скачать аудио из Telegram.', msg.message_id)
    return
  }

  let result: TranscriptionResult
  try {
    result = await deps.transcribe(bytes, filename)
  } catch (e) {
    console.error('[telegram] transcription error:', e)
    await deps.api.sendMessage(msg.chat.id, '⚠️ Ошибка распознавания. Попробуй ещё раз.', msg.message_id)
    return
  }

  const text = result.text.trim()
  if (!text) {
    await deps.api.sendMessage(msg.chat.id, '🤷 Пусто — в записи ничего не удалось распознать.', msg.message_id)
    return
  }

  for (const chunk of chunkForTelegram(text)) {
    await deps.api.sendMessage(msg.chat.id, `<code>${escapeHtml(chunk)}</code>`, msg.message_id)
  }
}

// ─── Real Telegram API over fetch ───────────────────────────────────────────

export function createTelegramApi(token: string): TelegramApi {
  const base = `https://api.telegram.org/bot${token}`
  const fileBase = `https://api.telegram.org/file/bot${token}`

  return {
    async getUpdates(offset, timeoutSec) {
      const url =
        `${base}/getUpdates?offset=${offset}&timeout=${timeoutSec}` +
        `&allowed_updates=${encodeURIComponent(JSON.stringify(['message']))}`
      // Long-poll can block up to timeoutSec server-side; give the socket a
      // generous ceiling beyond that so a healthy poll is never aborted.
      const res = await fetch(url, { signal: AbortSignal.timeout((timeoutSec + 15) * 1000) })
      const data = (await res.json()) as { ok: boolean; description?: string; result?: TgUpdate[] }
      if (!data.ok) throw new Error(`getUpdates failed: ${data.description ?? res.status}`)
      return data.result ?? []
    },

    async getFilePath(fileId) {
      const res = await fetch(`${base}/getFile?file_id=${encodeURIComponent(fileId)}`)
      const data = (await res.json()) as {
        ok: boolean
        description?: string
        result?: { file_path?: string }
      }
      if (!data.ok || !data.result?.file_path) {
        throw new Error(`getFile failed: ${data.description ?? 'no file_path'}`)
      }
      return data.result.file_path
    },

    async downloadFile(filePath) {
      const res = await fetch(`${fileBase}/${filePath}`)
      if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
      return new Uint8Array(await res.arrayBuffer())
    },

    async sendMessage(chatId, html, replyToMessageId) {
      const body: Record<string, unknown> = {
        chat_id: chatId,
        text: html,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }
      if (replyToMessageId) {
        body.reply_parameters = { message_id: replyToMessageId, allow_sending_without_reply: true }
      }
      const res = await fetch(`${base}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`sendMessage failed: HTTP ${res.status} ${await res.text()}`)
    },

    async sendChatAction(chatId, action) {
      await fetch(`${base}/sendChatAction`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, action }),
      })
    },
  }
}

// ─── Long-poll loop ─────────────────────────────────────────────────────────

export interface TelegramBotHandle {
  stop(): void
}

export interface StartBotOptions {
  token: string
  allowedUserIds: Set<number>
  transcribe: TranscribeFn
  api?: TelegramApi // injectable for tests
  pollTimeoutSec?: number
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function startTelegramBot(opts: StartBotOptions): TelegramBotHandle {
  const api = opts.api ?? createTelegramApi(opts.token)
  const deps: HandlerDeps = { api, transcribe: opts.transcribe, allowedUserIds: opts.allowedUserIds }
  const timeoutSec = opts.pollTimeoutSec ?? 25
  let running = true
  let offset = 0

  const allowlistNote = opts.allowedUserIds.size
    ? [...opts.allowedUserIds].join(',')
    : 'EMPTY — setup mode (bot replies with each sender’s ID)'
  console.log(`[telegram] bot started (allowlist: ${allowlistNote})`)

  ;(async () => {
    while (running) {
      try {
        const updates = await api.getUpdates(offset, timeoutSec)
        for (const u of updates) {
          offset = u.update_id + 1
          if (!u.message) continue
          try {
            await handleMessage(u.message, deps)
          } catch (e) {
            console.error('[telegram] handler error:', e)
          }
        }
      } catch (e) {
        if (!running) break
        console.error('[telegram] poll error:', e)
        await sleep(3000) // back off before retrying so we don't hot-loop on outages
      }
    }
    console.log('[telegram] bot stopped')
  })()

  return {
    stop() {
      running = false
    },
  }
}
