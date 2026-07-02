// Production entry: read env via src/config.ts, start the server, wire up
// graceful shutdown on SIGINT/SIGTERM.

import { config } from './config'
import { startServer } from './server'
import { startTelegramBot, type TelegramBotHandle } from './telegram-bot'
import { transcribeAudio } from './transcribe'

const server = await startServer({
  dataDir: config.dataDir,
  port: config.port,
  useTls: config.useTls,
  allowlist: config.allowedEmails,
  ownerEmail: config.ownerEmail,
  adminToken: config.adminToken,
  googleClientId: config.googleClientId,
  googleClientSecret: config.googleClientSecret,
  publicUrl: config.publicUrl,
})

console.log(`voice-clip listening on :${server.port}`)

// Optional personal Telegram transcription bot — only starts when a token is
// configured. Runs as a background long-poll loop alongside the HTTP server.
let telegramBot: TelegramBotHandle | undefined
if (config.telegramBotToken) {
  telegramBot = startTelegramBot({
    token: config.telegramBotToken,
    allowedUserIds: new Set(config.telegramAllowedUserIds),
    transcribe: transcribeAudio,
  })
}

function shutdown(signal: string) {
  console.log(`received ${signal}, shutting down`)
  telegramBot?.stop()
  server.stop()
  process.exit(0)
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
