# ADR 0004 — Pro tier pricing: $3 / 50 clips / 5-min cap + owner-comp tier

Status: **Accepted** · 2026-05-26

Supersedes Decisions #4 and #5 of [ADR 0003](0003-monetization-scaffold.md).

## Context

ADR 0003 left Pro as "unlimited for some future $5". Once the PWA hit the
first paying-customer conversation, two gaps surfaced:

1. **No cost ceiling on Pro.** A single user could record 100 × 5-minute
   clips in a month and burn well past the $3 we'd collect. "Unlimited"
   only works for us if average per-user cost stays an order of magnitude
   below the price — true at our current scale, but not durable.
2. **No way to comp the owner / household.** Once Pro becomes metered,
   the owner needs a separate tier that the cap doesn't apply to —
   otherwise dogfooding eats into the same quota as a paying user.

## Cost data backing the decision

Pulled from production `history` (530 clips, all of 2026-05):

| metric | $/clip |
|---|---|
| avg | $0.0022 |
| p50 | $0.0015 |
| p90 | $0.0047 |
| p99 | $0.0094 |
| max observed | $0.0213 |

OpenAI `gpt-4o-transcribe` charges by audio tokens. A 5-min clip
(at ~6 audio tokens/sec per the public price sheet) tops out near
**$0.025** in our model — matching the observed max once you allow for
variance in the audio-token rate.

Stripe fee on a $3 charge: ~$0.39 (2.9 % + $0.30) ⇒ **$2.61 net**.

## Decisions

### 1. Pro = $3 / mo · 50 clips · 5-min/clip cap

| scenario | cost | margin on $2.61 net |
|---|---|---|
| every clip at max length ($0.025) | $1.25 | **52 %** |
| p90 mix ($0.0047 avg) | $0.24 | 91 % |
| historical average ($0.0022) | $0.11 | 96 % |

50 is the sweet spot: ≥50 % margin guaranteed even in the
adversarial "every clip is 5 minutes of dense speech" case, while still
being a clearly visible jump from the Free tier's 30/mo. We rejected
- **30/mo** — too close to Free, no headroom for "I'm a heavy user, want more"
- **100/mo** — worst-case cost $2.50, margin < 5 % once Stripe is in
- **Unlimited for $3** — same unbounded-loss problem ADR 0003 left open

The 5-min/clip cap is enforced **twice** — client-side auto-stop
(`MAX_RECORD_MS` in `web/app.ts`) and server-side bytes cap
(`maxAudioBytes`, default 5 MB ≈ 5 min iPhone mp4/AAC at ~128 kbps).
Server-side is the load-bearing one; client-side just keeps the UI
honest so users don't bank a 20-minute recording and then see it
rejected.

### 2. New `'unlimited'` plan tier — bypasses every cap

Added to the `Plan` union (`'free' | 'pro' | 'unlimited'`). Server logic:
- `/upload` quota gate: skipped entirely when plan='unlimited'
- Per-clip bytes ceiling: bypassed when plan='unlimited'

Use case is owner-comp: owner + household members shouldn't compete
with paying users for quota. Set by `UPDATE user_plans SET
plan='unlimited' WHERE user_id=…`. UI surfaces it as "Unlimited / No
monthly cap" on the profile chip.

Rejected alternatives:
- **Reuse the `is_owner` flag for the bypass.** Coupling product
  pricing to an admin role makes "comp my wife's account" require
  promoting her to admin. Three plan values is one column and stays
  decoupled.
- **A boolean `quota_override` column on `users`.** Same effect, more
  schema. The `Plan` enum is the existing API contract; widening it is
  the cheaper diff.

### 3. `/me` returns plan-aware `monthly_limit`

Old shape returned `free_monthly_limit` regardless of plan, which the
UI had to map manually. New field `usage.monthly_limit` is the actual
cap that applies to the current user (null = no cap). The legacy
`free_monthly_limit` remains in the payload until web + macOS clients
have shipped the migration; **don't drop it** without checking the
macOS app — its update cadence is GitHub Releases, not server-pushed.

## What we still didn't do

- **Stripe** — same plan as ADR 0003. The metered Pro tier makes the
  "do friends actually pay" signal easier to read (the cap is a real
  thing now, not just a UI label), but billing wiring is still gated
  on getting that signal.
- **Per-plan invite limits.** Pro-tier users still can't invite anyone;
  invites stay owner-only until we have a reason to change that.
- **Annual plans / multi-tier ladder.** One paid tier until there's
  demand for a higher one.

## Migration

No schema change — `user_plans.plan` is already `TEXT`, so the new
`'unlimited'` value lands without a migration. Existing rows continue
to read `'free'` (implicit) or `'pro'`. The store's `getPlan` now
returns one of three values; callers that wrote `=== 'pro'` checks
have been updated to use the `limitFor(plan)` helper in `server.ts`.

## Consequences

- Pro is now a real product gate — running out of quota at clip 50
  surfaces a 402 with `code: 'quota_exceeded', plan: 'pro'`, and the
  UI chip turns red ("Cap reached" instead of "Upgrade").
- Owner-comp is now a one-line DB update, not a code change.
- `/pro` page copy is the truth: $3 / 50 transcriptions / 5-min cap.
  When marketing changes, update both the page AND this ADR.
- We can flip the repo to private without losing the Stripe path —
  payment isn't wired yet anyway.
