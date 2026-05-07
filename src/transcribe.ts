import OpenAI, { toFile } from 'openai'
import { config } from './config'

const openai = new OpenAI({ apiKey: config.openaiApiKey })

export async function transcribeTelegramVoice(filePath: string): Promise<string> {
  const url = `https://api.telegram.org/file/bot${config.telegramToken}/${filePath}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Telegram file download failed: ${res.status}`)

  const file = await toFile(res, 'voice.ogg')
  const transcription = await openai.audio.transcriptions.create({
    file,
    model: 'gpt-4o-transcribe',
  })
  return transcription.text
}
