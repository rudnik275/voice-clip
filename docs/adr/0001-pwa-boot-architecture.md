# 0001 — PWA boot architecture: cache-first service worker + static shell

Status: accepted (2026-05-21)

## Context

The PWA had two visible latency points on iPhone:

1. **Reopen after backgrounding** — when Safari evicts the standalone PWA's
   tab (which it does aggressively, even after seconds of background), the
   next open performs a full network round-trip for the HTML at `/` before
   anything renders. HTML is served with `cache-control: no-store` because
   it embeds versioned asset URLs (`/style.css?v=HASH`, `/app.ts?v=HASH`).
   On cellular this is a visible 0.5–2s of blank white.

2. **First tap on the record button** — `getUserMedia` is awaited inside
   the `click` handler. After the existing 1200ms `MIC_IDLE_RELEASE_MS`
   grace window has elapsed, the mic stream is torn down and the next tap
   pays the full iOS activation cost (~200–500ms). Within the grace window
   subsequent recordings are instant.

The product target is "instant" — comparable to opening a chat in Telegram
or hitting the record button in iOS Voice Memos. The two delays above are
the dominant contributors and need different levers.

## Decision

### Service worker, cache-first, reload on next open

`web/sw.js` precaches the bootable shell (`/`, `/style.css?v=HASH`,
`/app.ts?v=HASH`) at install time. The fetch handler serves these from
cache before consulting the network. New versions are detected by the
standard SW update flow: the served `sw.js` byte-changes whenever
`ASSET_VER` changes (which includes the SW file's own content), the
browser background-installs the new SW into the `waiting` state, and it
activates the next time all controlled clients are closed — i.e. the
next time the PWA is fully reopened. The new SW does NOT call
`skipWaiting()` or `clients.claim()`, deliberately, to avoid disrupting
an in-flight recording with a mid-session controller swap.

Consequence: deploys reach the device one PWA-open later than the push
to `main`. Acceptable for a solo-user product.

### Static shell + client-side hydration

`GET /` returns a fixed `home.html` for everyone — no server-side
templating. The `__NAME__` and `__APP_VERSION__` placeholders are gone.

On boot, `app.ts`:
- reads cached name + email from `localStorage` and paints the top-bar
  immediately (zero flicker for repeat users);
- fetches `/me` in parallel: on 200, refreshes the cached identity; on
  401, replaces the location with `/login`.

Login lives at its own URL (`/login`) so the home shell can be cached
as a single immutable blob. The OAuth callback continues to land on
`/`, where the now-fresh session cookie causes `/me` to succeed.

The alternative considered — SW knowing the auth flag via `postMessage`
from the page — was rejected because it pushes auth state into a second
storage (SW IndexedDB) and creates subtle correlation bugs between page
state and SW state on logout. The static shell pattern keeps auth state
in one place (the session cookie + the cached identity it produced).

### Mic pre-warm on `touchstart` over the record button

A `touchstart` handler on `#rec` calls `ensureMic()` in parallel with
the click pipeline. iOS reports `touchstart` 50–200ms before `click`,
so the `getUserMedia` round-trip overlaps the user's finger lifting.
If the user touches the button but doesn't actually tap (touch ends
elsewhere), the existing `scheduleMicRelease()` 1200ms timer releases
the mic — the orange iOS indicator turns off — without any new code.

The aggressive alternative (warm the mic on `visibilitychange→visible`
or hold it persistently while the PWA is foregrounded) was rejected
because iOS shows the orange "mic in use" indicator the entire time a
live MediaStream exists. Lighting it up just because the user opened
the app to check history is intrusive. The touch-on-button trigger
limits the indicator to the seconds you actually intend to record.

Push-to-hold semantics were also rejected. The button stays
tap-to-toggle (first tap = start, second = stop). `touchstart` is
strictly a head-start hint to `ensureMic`; it does NOT call
`startRecording()`.

Empirical check required before relying on this: confirm that iOS
Safari in standalone PWA mode accepts `getUserMedia` initiated from a
`touchstart` handler, not only `click`. If iOS rejects it, fall back to
the previous behavior (acquire mic in the `click` handler only).

## Consequences

- Cold PWA reopen is now disk-bound: shell renders in ~50–150ms with
  no network involvement.
- First-tap-to-recording latency drops by ~50–200ms when the mic was
  cold; the 1200ms warm window continues to make subsequent recordings
  instant.
- HTML is no longer auth-aware, so existing tests that asserted the
  user's name appears in the HTML at `/` move to asserting it appears
  in the `/me` response instead.
- Deploys are one foreground late on the user's device. The
  `APP_VERSION` constant still bumps per release, the SW's precache
  key includes it, and the `/version` endpoint remains the
  authoritative live value if you ever need to verify what's running.

## Trade-offs not taken

- **Network-first `/` with short timeout fallback to cache** — keeps
  deploys instant at the cost of 100–300ms cold-start when the network
  is slow. Rejected: defeats the "zero network at open" goal.
- **iOS splash screens** (`apple-touch-startup-image`) — would mask any
  remaining white moment with a branded splash. Cheap and orthogonal,
  but explicitly deferred this round.
- **Inline critical CSS in the HTML** — once the SW is serving CSS from
  cache, the savings approach zero. Skipped.
- **Code splitting for history/profile modals** — would save ~20–50ms
  of boot parse on a slow phone. Deferred until measurement shows the
  parse step is a real bottleneck.
