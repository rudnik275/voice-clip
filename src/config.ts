// Server config — fail-fast at startup if any required env var is missing.
// Tests bypass this by passing explicit deps into startServer().

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

function parseAllowlist(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0)
}

export const config = {
  openaiApiKey: requireEnv('OPENAI_API_KEY'),
  googleClientId: requireEnv('GOOGLE_OAUTH_CLIENT_ID'),
  googleClientSecret: requireEnv('GOOGLE_OAUTH_CLIENT_SECRET'),
  publicUrl: requireEnv('PUBLIC_URL'),
  allowedEmails: parseAllowlist(requireEnv('VOICE_CLIP_ALLOWED_EMAILS')),
  // Optional — when set, /admin/* endpoints (e.g. /admin/errors) check the
  // X-Admin-Token header against this value. If unset the admin routes
  // are 503'd so an unconfigured deploy can't be poked.
  adminToken: process.env.ADMIN_TOKEN,
  port: Number(process.env.PORT ?? 8080),
  dataDir: process.env.DATA_DIR ?? './data',
  // TLS terminates at Cloudflare Tunnel; container always serves plain HTTP.
  useTls: false,
}
