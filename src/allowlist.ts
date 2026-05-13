// Email allowlist for Google OAuth login.
//
// Single source of truth = VOICE_CLIP_ALLOWED_EMAILS env var (comma-separated).
// We parse once at startup, normalise to lowercase, and expose a tiny
// `isAllowed(email)` predicate. Anything not on the list is rejected with
// the "Access denied" page (NO session is created).

export interface Allowlist {
  isAllowed(email: string): boolean
}

export function parseAllowedEmails(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0)
}

export function createAllowlist(emails: readonly string[]): Allowlist {
  const set = new Set(emails.map((e) => e.trim().toLowerCase()))
  return {
    isAllowed(email: string): boolean {
      if (!email) return false
      return set.has(email.trim().toLowerCase())
    },
  }
}
