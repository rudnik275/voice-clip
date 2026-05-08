import OpenAI, { toFile } from 'openai'
import { config } from './config'
import type { Usage } from './pricing'

const openai = new OpenAI({ apiKey: config.openaiApiKey })

const LANGUAGE_PROMPT =
  'Транскрипт устной речи. Основной язык — русский, иногда украинский, иногда английский. ' +
  'В речи часто встречаются английские технические термины (API, deployment, refactor, TypeScript, React) — их нужно сохранять как есть, не транслитерировать и не переводить. ' +
  'Розмова може переходити українською мовою. Sometimes the speaker switches to English entirely.'

export interface TranscriptionResult {
  text: string
  usage?: Usage
}

export async function transcribeAudio(input: Uint8Array, filename: string): Promise<TranscriptionResult> {
  const file = await toFile(input, filename)
  const transcription = await openai.audio.transcriptions.create({
    file,
    model: 'gpt-4o-transcribe',
    prompt: LANGUAGE_PROMPT,
  })

  const raw = transcription.usage
  let usage: Usage | undefined
  if (raw && raw.type === 'tokens') {
    usage = {
      audioTokens: raw.input_token_details?.audio_tokens ?? 0,
      textTokens: raw.input_token_details?.text_tokens ?? 0,
      outputTokens: raw.output_tokens ?? 0,
    }
  }
  return { text: transcription.text, usage }
}
