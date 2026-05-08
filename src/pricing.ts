// gpt-4o-transcribe pricing (USD per 1M tokens), as published by OpenAI.
const PRICE_PER_MILLION = {
  audioInput: 6.0,
  textInput: 2.5,
  output: 10.0,
}

export interface Usage {
  audioTokens: number
  textTokens: number
  outputTokens: number
}

export function calcCostUsd(u: Usage): number {
  return (
    (u.audioTokens * PRICE_PER_MILLION.audioInput +
      u.textTokens * PRICE_PER_MILLION.textInput +
      u.outputTokens * PRICE_PER_MILLION.output) /
    1_000_000
  )
}
