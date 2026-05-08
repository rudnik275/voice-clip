import { describe, expect, test } from 'bun:test'
import { calcCostUsd } from '../src/pricing'

describe('pricing.calcCostUsd', () => {
  test('zero usage → zero cost', () => {
    expect(calcCostUsd({ audioTokens: 0, textTokens: 0, outputTokens: 0 })).toBe(0)
  })

  test('audio-only at OpenAI rate ($6 / 1M)', () => {
    // 1,000,000 audio tokens = $6
    expect(calcCostUsd({ audioTokens: 1_000_000, textTokens: 0, outputTokens: 0 })).toBeCloseTo(6, 6)
    // 100,000 audio tokens = $0.6
    expect(calcCostUsd({ audioTokens: 100_000, textTokens: 0, outputTokens: 0 })).toBeCloseTo(0.6, 6)
  })

  test('text input at $2.5 / 1M, output at $10 / 1M', () => {
    expect(calcCostUsd({ audioTokens: 0, textTokens: 1_000_000, outputTokens: 0 })).toBeCloseTo(2.5, 6)
    expect(calcCostUsd({ audioTokens: 0, textTokens: 0, outputTokens: 1_000_000 })).toBeCloseTo(10, 6)
  })

  test('mixed usage sums correctly', () => {
    // 50k audio + 1k text + 200 output
    // = (50000 * 6 + 1000 * 2.5 + 200 * 10) / 1_000_000
    // = (300000 + 2500 + 2000) / 1_000_000 = 0.3045
    const cost = calcCostUsd({ audioTokens: 50_000, textTokens: 1_000, outputTokens: 200 })
    expect(cost).toBeCloseTo(0.3045, 6)
  })

  test('typical short voice request stays in cents', () => {
    // ~10s of speech ≈ 250 audio tokens; ~50 chars of text ≈ ~30 output tokens
    const cost = calcCostUsd({ audioTokens: 250, textTokens: 80, outputTokens: 30 })
    expect(cost).toBeLessThan(0.01)
    expect(cost).toBeGreaterThan(0)
  })
})
