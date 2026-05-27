# voice-clip — domain language

Single-context project; this file is the canonical glossary. When code or UI
uses one of these terms, it must match the definition here. When the
definition changes, the file changes — never let code drift.

## Terms

### Clip

A single voice-recording → transcribed text round-trip. One row in `history`,
one increment of the monthly quota counter. Created on `POST /upload`.

### Recorder

Any client that can capture audio and POST `/upload`. Today: the mobile PWA,
the desktop-browser PWA, and the Tauri macOS app's webview. The REC button is
the user-facing affordance for "this client is a recorder."

Recorders write the resulting transcript into **their own local clipboard**
(via `navigator.clipboard.write`) — that lands the text on the same machine
the user was just looking at when they tapped REC. This is unconditional and
not tied to the Receiver concept below.

### Receiver

Today: a paired Tauri macOS app. Identified by an opaque `device_token` in
the device's macOS Keychain, mapped via the `devices` table to a user.
Receivers hold a long-lived SSE connection to `/events`, get every Clip the
user produces on any Recorder fan'd out to them, and `pbcopy` it onto the
Mac's system clipboard.

> **Future direction**: extend Receivers to include any signed-in client —
> phone PWA, desktop browser tab, etc. — so a Clip recorded on one device
> lands in every device's clipboard. The `device_token` flow is currently
> Mac-only; the generalisation would need session-scoped SSE delivery and a
> per-client way to write to the local clipboard (already exists in the PWA
> via `navigator.clipboard`, just not driven by an SSE listener yet).

### Device

A registered Receiver — a row in the `devices` table. Today synonymous with
"paired Mac". User-facing label in the Profile modal: **"Paired devices"**.

When the Future direction above lands, **this term must NOT broaden in
place**. Either:
- The new generalised receivers get a different table + a different UI
  label ("Connected devices", "Sessions", etc.), keeping "Paired devices"
  Mac-only, OR
- The `devices` table is renamed and the UI follows.

Silently widening "device" to mean "any signed-in client" would break the
expectation that Profile → Paired devices = pbcopy targets that survive
across browser closes.

### Session

Server-side HTTP session, identified by the `session=<hex>` cookie. Backs
the PWA's auth on every API call. Has no user-facing surface — users don't
think in "sessions", they think in "I'm signed in on my phone / my laptop".

### Paired (verb)

The OAuth-deep-link round-trip that issues a `device_token` to a Tauri Mac.
Only Macs get paired (today). Browser tabs and phone PWAs **sign in** (they
get a Session cookie) but they don't **pair** (no `device_token`).
