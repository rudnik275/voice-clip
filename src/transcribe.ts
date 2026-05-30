import OpenAI, { toFile } from 'openai'
import { config } from './config'
import type { Usage, ChatUsage } from './pricing'

const openai = new OpenAI({ apiKey: config.openaiApiKey })

// Note: don't list specific tech terms here. On silent audio Whisper / gpt-4o-transcribe
// hallucinates plausible continuations of the prompt — listing "TypeScript, React, ..."
// reliably produced fake transcripts like "Я работала с React на TypeScript".
const LANGUAGE_PROMPT =
  'Транскрипт диктофонной записи на русском, украинском или английском. ' +
  'Английские слова и термины сохраняй в оригинальном написании, не транслитерируй кириллицей. ' +
  'Если в аудио ничего не сказано — верни пустую строку.'

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

// Post-process the raw transcript text using gpt-4o-mini with the given
// system-instruction prompt from the user's active preset. This is a purely
// text-to-text transformation — it never re-triggers audio recording, so
// self-referential prompts (e.g. "transcribe this") are harmless.
export interface PostProcessResult {
  text: string
  usage?: ChatUsage
}

export async function postProcessTranscript(
  text: string,
  presetPrompt: string,
): Promise<PostProcessResult> {
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: presetPrompt },
      { role: 'user', content: text },
    ],
  })

  const content = completion.choices[0]?.message?.content ?? text
  let usage: ChatUsage | undefined
  if (completion.usage) {
    usage = {
      inputTokens: completion.usage.prompt_tokens,
      outputTokens: completion.usage.completion_tokens,
    }
  }
  return { text: content, usage }
}
