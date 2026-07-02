import { test, expect, mock } from 'bun:test'
import {
  handleMessage,
  startTelegramBot,
  parseTelegramUserIds,
  escapeHtml,
  chunkForTelegram,
  telegramFilename,
  type TelegramApi,
  type TgMessage,
  type TgUpdate,
  type HandlerDeps,
} from '../src/telegram-bot'

// ─── Fake Telegram API that records calls ───────────────────────────────────

interface SentMessage {
  chatId: number
  html: string
  replyTo?: number
}

function fakeApi(overrides: Partial<TelegramApi> = {}) {
  const sent: SentMessage[] = []
  const getFilePathCalls: string[] = []
  const api: TelegramApi = {
    getUpdates: mock(async () => []),
    getFilePath: mock(async (fileId: string) => {
      getFilePathCalls.push(fileId)
      return `voice/${fileId}.oga`
    }),
    downloadFile: mock(async () => new Uint8Array([1, 2, 3])),
    sendMessage: mock(async (chatId: number, html: string, replyTo?: number) => {
      sent.push({ chatId, html, replyTo })
    }),
    sendChatAction: mock(async () => {}),
    ...overrides,
  }
  return { api, sent, getFilePathCalls }
}

function voiceMsg(fromId: number, extra: Partial<TgMessage> = {}): TgMessage {
  return {
    message_id: 42,
    from: { id: fromId, username: 'tester' },
    chat: { id: 555 },
    voice: { file_id: 'FILE123' },
    ...extra,
  }
}

// ─── Pure helpers ───────────────────────────────────────────────────────────

test('parseTelegramUserIds parses a comma list, drops junk and zero', () => {
  const ids = parseTelegramUserIds(' 111, 222 ,x, 0, 333 ')
  expect([...ids].sort()).toEqual([111, 222, 333])
})

test('parseTelegramUserIds returns empty set for undefined/empty', () => {
  expect(parseTelegramUserIds(undefined).size).toBe(0)
  expect(parseTelegramUserIds('').size).toBe(0)
})

test('escapeHtml escapes only & < >', () => {
  expect(escapeHtml('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d')
  expect(escapeHtml('обычный текст')).toBe('обычный текст')
})

test('chunkForTelegram keeps short text as one chunk', () => {
  expect(chunkForTelegram('короткий текст')).toEqual(['короткий текст'])
})

test('chunkForTelegram splits long text under the limit, prefers space breaks', () => {
  const words = Array.from({ length: 400 }, (_, i) => `слово${i}`).join(' ')
  const chunks = chunkForTelegram(words, 100)
  expect(chunks.length).toBeGreaterThan(1)
  for (const c of chunks) expect(c.length).toBeLessThanOrEqual(100)
  // Reassembling on spaces yields the original tokens (no word lost/cut).
  expect(chunks.join(' ').split(/\s+/)).toEqual(words.split(' '))
})

test('telegramFilename derives extension from the Telegram file_path', () => {
  expect(telegramFilename('voice/abc.oga', voiceMsg(1))).toBe('clip.oga')
  expect(telegramFilename('video_notes/x.mp4', voiceMsg(1, { voice: undefined, video_note: { file_id: 'v' } }))).toBe(
    'clip.mp4',
  )
  // No extension in path → falls back to a sane default per media type.
  expect(telegramFilename('voice/noext', voiceMsg(1))).toBe('clip.oga')
})

// ─── handleMessage behavior ─────────────────────────────────────────────────

test('allowed user: voice is downloaded, transcribed, replied as tap-to-copy <code>', async () => {
  const { api, sent, getFilePathCalls } = fakeApi()
  const transcribe = mock(async () => ({ text: '  привет мир  ' }))
  const deps: HandlerDeps = { api, transcribe, allowedUserIds: new Set([111]) }

  await handleMessage(voiceMsg(111), deps)

  expect(getFilePathCalls).toEqual(['FILE123'])
  expect(transcribe).toHaveBeenCalledTimes(1)
  expect(sent).toHaveLength(1)
  expect(sent[0]!).toEqual({ chatId: 555, html: '<code>привет мир</code>', replyTo: 42 })
})

test('transcribe receives a filename with the file_path extension', async () => {
  const filenames: string[] = []
  const { api } = fakeApi()
  const transcribe = mock(async (_bytes: Uint8Array, filename: string) => {
    filenames.push(filename)
    return { text: 'ok' }
  })
  const deps: HandlerDeps = { api, transcribe, allowedUserIds: new Set([111]) }

  await handleMessage(voiceMsg(111), deps)
  expect(filenames).toEqual(['clip.oga'])
})

test('transcript HTML special chars are escaped inside <code>', async () => {
  const { api, sent } = fakeApi()
  const transcribe = mock(async () => ({ text: 'if a < b && c > d' }))
  const deps: HandlerDeps = { api, transcribe, allowedUserIds: new Set([111]) }

  await handleMessage(voiceMsg(111), deps)
  expect(sent[0]!.html).toBe('<code>if a &lt; b &amp;&amp; c &gt; d</code>')
})

test('empty transcription → friendly "пусто" reply, not an empty code block', async () => {
  const { api, sent } = fakeApi()
  const transcribe = mock(async () => ({ text: '   ' }))
  const deps: HandlerDeps = { api, transcribe, allowedUserIds: new Set([111]) }

  await handleMessage(voiceMsg(111), deps)
  expect(sent).toHaveLength(1)
  expect(sent[0]!.html).not.toContain('<code>')
  expect(sent[0]!.html).toContain('Пусто')
})

test('transcription error → error reply, no crash', async () => {
  const { api, sent } = fakeApi()
  const transcribe = mock(async () => {
    throw new Error('openai down')
  })
  const deps: HandlerDeps = { api, transcribe, allowedUserIds: new Set([111]) }

  await handleMessage(voiceMsg(111), deps)
  expect(sent).toHaveLength(1)
  expect(sent[0]!.html).toContain('Ошибка распознавания')
})

test('download error → error reply, transcribe never called', async () => {
  const transcribe = mock(async () => ({ text: 'unused' }))
  const { api, sent } = fakeApi({
    getFilePath: mock(async () => {
      throw new Error('getFile 400')
    }),
  })
  const deps: HandlerDeps = { api, transcribe, allowedUserIds: new Set([111]) }

  await handleMessage(voiceMsg(111), deps)
  expect(transcribe).toHaveBeenCalledTimes(0)
  expect(sent[0]!.html).toContain('Не смог скачать')
})

test('non-allowed user is ignored silently — nothing sent, no transcribe', async () => {
  const { api, sent } = fakeApi()
  const transcribe = mock(async () => ({ text: 'secret' }))
  const deps: HandlerDeps = { api, transcribe, allowedUserIds: new Set([111]) }

  await handleMessage(voiceMsg(999), deps)
  expect(sent).toHaveLength(0)
  expect(transcribe).toHaveBeenCalledTimes(0)
})

test('setup mode (empty allowlist) replies with the sender Telegram ID', async () => {
  const { api, sent } = fakeApi()
  const transcribe = mock(async () => ({ text: 'x' }))
  const deps: HandlerDeps = { api, transcribe, allowedUserIds: new Set<number>() }

  await handleMessage(voiceMsg(777), deps)
  expect(transcribe).toHaveBeenCalledTimes(0)
  expect(sent).toHaveLength(1)
  expect(sent[0]!.html).toContain('<code>777</code>')
})

test('allowed user sends plain text → hint to forward a voice', async () => {
  const { api, sent } = fakeApi()
  const transcribe = mock(async () => ({ text: 'x' }))
  const deps: HandlerDeps = { api, transcribe, allowedUserIds: new Set([111]) }

  await handleMessage({ message_id: 1, from: { id: 111 }, chat: { id: 555 }, text: '/start' }, deps)
  expect(transcribe).toHaveBeenCalledTimes(0)
  expect(sent[0]!.html).toContain('голосовое')
})

test('audio-document with audio/* mime is accepted', async () => {
  const filenames: string[] = []
  const { api, sent } = fakeApi({
    getFilePath: mock(async (id: string) => `music/${id}.mp3`),
  })
  const transcribe = mock(async (_b: Uint8Array, f: string) => {
    filenames.push(f)
    return { text: 'из документа' }
  })
  const deps: HandlerDeps = { api, transcribe, allowedUserIds: new Set([111]) }

  const msg: TgMessage = {
    message_id: 7,
    from: { id: 111 },
    chat: { id: 555 },
    document: { file_id: 'DOC1', mime_type: 'audio/mpeg', file_name: 'note.mp3' },
  }
  await handleMessage(msg, deps)
  expect(filenames).toEqual(['clip.mp3'])
  expect(sent[0]!.html).toBe('<code>из документа</code>')
})

test('startTelegramBot poll loop advances offset and routes updates to the handler', async () => {
  const { api, sent } = fakeApi()

  const offsets: number[] = []
  let resolveSecondPoll: () => void = () => {}
  // Resolves once the loop polls AGAIN after consuming the first update — by
  // then handleMessage (and its sendMessage) has already run and the offset has
  // advanced, so both assertions are race-free.
  const secondPoll = new Promise<void>((r) => {
    resolveSecondPoll = r
  })
  api.getUpdates = mock(async (offset: number) => {
    offsets.push(offset)
    if (offset === 0) {
      const update: TgUpdate = { update_id: 500, message: voiceMsg(111) }
      return [update]
    }
    resolveSecondPoll()
    return []
  })

  const transcribe = mock(async () => ({ text: 'через луп' }))
  const bot = startTelegramBot({
    token: 'unused',
    allowedUserIds: new Set([111]),
    transcribe,
    api,
    pollTimeoutSec: 0,
  })

  await secondPoll
  bot.stop()

  expect(sent[0]!.html).toBe('<code>через луп</code>')
  // offset must advance past the consumed update (update_id + 1).
  expect(offsets[0]).toBe(0)
  expect(offsets).toContain(501)
})

test('long transcript is delivered as multiple <code> chunks', async () => {
  const long = Array.from({ length: 2000 }, (_, i) => `слово${i}`).join(' ')
  const { api, sent } = fakeApi()
  const transcribe = mock(async () => ({ text: long }))
  const deps: HandlerDeps = { api, transcribe, allowedUserIds: new Set([111]) }

  await handleMessage(voiceMsg(111), deps)
  expect(sent.length).toBeGreaterThan(1)
  for (const m of sent) {
    expect(m.html.startsWith('<code>')).toBe(true)
    expect(m.html.endsWith('</code>')).toBe(true)
    expect(m.replyTo).toBe(42)
  }
})
