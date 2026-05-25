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
  // Seed list — read into the DB allowed_emails table on boot (idempotent).
  // After that, friends arrive via invite links and the table grows.
  allowedEmails: parseAllowlist(requireEnv('VOICE_CLIP_ALLOWED_EMAILS')),
  // Optional: marks one email as the "owner" → /me returns is_owner=true,
  // profile UI shows the "Generate invite" button, /admin/invites accepts
  // their session without needing the X-Admin-Token header.
  ownerEmail: process.env.OWNER_EMAIL,
  // Optional shared-secret for /admin/* endpoints (errors, invites). When
  // set, ops scripts can hit them via X-Admin-Token. Unset → all admin
  // routes return 401 (the owner session is still a valid alternative).
  adminToken: process.env.ADMIN_TOKEN,
  port: Number(process.env.PORT ?? 8080),
  dataDir: process.env.DATA_DIR ?? './data',
  // TLS terminates at Cloudflare Tunnel; container always serves plain HTTP.
  useTls: false,
}
