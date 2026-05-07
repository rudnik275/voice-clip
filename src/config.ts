function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

const allowedIds = requireEnv('ALLOWED_USER_IDS')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => {
    const n = Number(s)
    if (!Number.isInteger(n)) throw new Error(`ALLOWED_USER_IDS contains non-integer: ${s}`)
    return n
  })

export const config = {
  telegramToken: requireEnv('TELEGRAM_BOT_TOKEN'),
  openaiApiKey: requireEnv('OPENAI_API_KEY'),
  allowedUserIds: new Set<number>(allowedIds),
}
