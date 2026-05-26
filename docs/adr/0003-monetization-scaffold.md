# ADR 0003 — Monetization scaffold: Free / Pro, DB allowlist, invite links

Status: **Accepted (partially superseded)** · 2026-05-25

> **Update 2026-05-26**: Decisions #4 and #5 below are superseded by
> [ADR 0004](0004-pro-tier-pricing.md), which moves Pro from "unlimited
> for $5" to a metered "$3 / 50 clips / 5-min cap" model and introduces
> a third `unlimited` tier for owner-comp use. Decisions #1–#3 (allowlist,
> invites, single-owner model) remain in force.

## Context

voice-clip transitioned from a 1-2-person personal tool to "give it to
friends, see if it's worth charging for." Three product decisions had to
land at once:

1. **How do friends get access** without a redeploy per email?
2. **What does the pricing model look like** so the UI surfaces something coherent today?
3. **Where does the in-product 'Upgrade' nudge live** even before payments are wired?

## Decisions

### 1. Allowlist moves env → DB (table `allowed_emails`)

`VOICE_CLIP_ALLOWED_EMAILS` env still seeds the table on every boot
(idempotent `INSERT OR IGNORE`) — existing deploys keep working — but
new emails arrive via invite-consume at runtime, not by editing `.env`
and rolling the container.

Schema is minimal: `(email PK, added_at, added_via 'env'|'invite'|'manual',
invited_by)`. `invited_by` is the owner's user_id when applicable, so
"who let this person in" is auditable.

### 2. Invite tokens are single-use, atomic-consume (table `invites`)

Owner generates a token via the profile UI (or `POST /admin/invites`),
shares the URL, friend opens it. The OAuth callback consumes the token
with `UPDATE … WHERE used_at IS NULL RETURNING *` — a race-safe atomic
operation that means the same link can never bring in two people.

Token cookies are HttpOnly, Secure, SameSite=Lax, 10-minute Max-Age:
long enough to survive the Google round-trip, short enough that a token
abandoned in the wild times out client-side anyway.

### 3. "Owner" is a single-email config bit, not a role table

`OWNER_EMAIL` env marks one user as the owner. `/me` reports `is_owner`,
the profile UI gates the **Generate invite** button on that, and
`/admin/*` accepts owner sessions in addition to `X-Admin-Token`. No
permissions matrix — there's literally one privileged user. If we ever
grow past "owner + invited friends," that's the right time for a real
role table.

### 4. Free tier with monthly quota, Pro = unlimited (tables `user_plans`, `usage_counters`)

Free = **30 clips / month** (configurable via `freeTierMonthlyLimit`
dep, default 30; 0 disables the gate). Over-cap `/upload` returns 402
`{code: 'quota_exceeded', used, limit}` BEFORE reading the request body,
so a capped user doesn't burn bandwidth. The counter increments only on
successful transcription — failed uploads don't burn the user's slot.

`user_plans` is keyed by `user_id`; missing row = implicit `'free'`. A
separate table (vs a `plan` column on `users`) keeps the schema migration
to a single idempotent `CREATE TABLE IF NOT EXISTS` — no `ALTER TABLE`.

### 5. `/pro` placeholder lives in the codebase today

A static self-contained HTML page at `/pro` shows the brutalism-style
upgrade card ($5/mo, four bullet points, disabled "Coming soon" CTA).
The quota chip in the profile modal links there. This gets the UX
copywriting + design pinned down before any payments work — and gives
users somewhere coherent to land when they hit the cap.

## What we explicitly didn't do

- **Stripe integration** — gated on early signal from friends that they'd actually pay. When ready: webhook → `plans.setPlan(userId, 'pro')`.
- **Per-user invite quotas** ("you have 3 invites left") — viral mechanics belong to a later phase. Owner-only invites cover the current scope.
- **Role / permission table** — single owner, see above.
- **Stripe + payment grace periods** — when added, the quota gate becomes 3-state (free / pro / past-due) and we'll need a billing-status column. Out of scope now.

## Repo-private consideration

Going private (for monetization) is **safe AFTER** fixing the Tauri
auto-updater. Current path: `/desktop/update.json` 302s to GitHub
Releases assets, which require auth on private repos. Two options:

1. **Mirror release artifacts via our own server.** CI uploads `latest.json` + `.dmg` to the voice-clip VPS (via SSH) or to S3. `/desktop/update.json` serves them directly instead of 302-ing. ~30 min change. Recommended.
2. **Keep a public release-only repo.** Tauri release CI pushes the .dmg + latest.json there; main code stays private. More moving parts.

Until one of these lands, **do not flip repo visibility to private** —
all installed desktop apps will silently stop updating.

The GHCR image (via `ghcr.io/rudnik275/voice-clip`) follows repo
visibility but the deploy job already authenticates with `GITHUB_TOKEN`
so the VPS pull keeps working. No action needed there.

## Consequences

- New users can join in under a minute, no redeploy
- Quota gives a natural product-funnel signal: who hits the cap = who would pay
- Owner can run the whole shop from the profile modal — no ops shell needed for the common path
- Until Stripe lands, "upgrade me to Pro" is a manual sqlite UPDATE
- `OWNER_EMAIL` + `ADMIN_TOKEN` env vars are now part of the deploy contract — see `docs/runbook/operations.md`
