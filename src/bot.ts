import { Bot } from 'grammy'
import { config } from './config'
import { transcribeTelegramVoice } from './transcribe'
import { copyToClipboard, notify } from './macos'

export function createBot(): Bot {
  const bot = new Bot(config.telegramToken)

  bot.use(async (ctx, next) => {
    if (!ctx.from) return
    if (!config.allowedUserIds.has(ctx.from.id)) {
      console.log(`[whitelist] ignored user ${ctx.from.id} (@${ctx.from.username ?? '—'})`)
      return
    }
    await next()
  })

  bot.on('message:voice', async (ctx) => {
    try {
      const file = await ctx.api.getFile(ctx.message.voice.file_id)
      if (!file.file_path) throw new Error('Telegram returned no file_path')

      const text = await transcribeTelegramVoice(file.file_path)
      const trimmed = text.trim()
      if (!trimmed) {
        await notify('Пустая транскрипция', '🎙 fail')
        return
      }
      await copyToClipboard(trimmed)
      await notify(trimmed, '🎙 → 📋')
    } catch (err) {
      console.error('[voice] error:', err)
      await notify('Ошибка распознавания', '🎙 fail').catch(() => {})
    }
  })

  return bot
}
