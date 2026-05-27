# ADR 0005 — Mic everywhere: recording is not phone-only

Status: **Accepted** · 2026-05-27

## Context

voice-clip started with an opinionated split: the **phone PWA records**, the
**Mac receives + pbcopies** (see memory `project_voice_capture_ux.md` and
ADR 0001's assumptions). The desktop-browser PWA hid the REC button on load
(`web/app.ts: if (isDesktop) recBtn.hidden = true`) and replaced it with a
yellow "Download Voice Clip for macOS" CTA. The Tauri Mac app didn't even
have a REC button — its only job was to hold an SSE stream and pbcopy.

Two things shifted that founding assumption:

1. **Tauri app now records** (PR #74). The same `web/` bundle powers the
   webview inside the .app, so the REC button rendered there too — except
   `isDesktop = !(pointer: coarse)` reads true on a Mac webview and hid
   it. Hiding REC inside the Mac app the user just installed for
   recording was incoherent.

2. **Desktop browser recording is technically already done.** `web/app.ts`
   already writes `navigator.clipboard.write()` on every successful upload
   (line 1069), and the server already fans out via SSE to every paired
   Receiver. Pressing REC in Chrome on a Mac would put the transcript in
   that Mac's clipboard AND on every other paired Mac — no extra code
   needed. The `isDesktop` hide was a UX choice, not a capability gate.

The original justification — "phone is the comfortable recorder because it
lies face-up; the laptop user should install the .app instead" — still holds
as an _ergonomic_ observation. It doesn't hold as a _capability_ restriction.

## Decision

### Recording UI is identical on every client

Remove the `isDesktop` hide. Mobile PWA, desktop-browser PWA, and Tauri
webview all show the same REC button, the same voice halo, the same history
modal — one bundle, one experience. A user who lands on `voice.rudifamily.uk`
in Chrome on a Mac sees the recorder, taps it, gets the text in their
system clipboard. Same flow as on the phone, same flow as in the .app.

### The Mac app stays valuable, but as a Receiver

The .app's distinguishing capability is **passive reception**: tray-resident,
receives Clips from any of the user's Recorders even when the browser is
closed, pbcopies on arrival, survives reboot via autostart. That's the
positioning, not "the only way to record".

### Download CTA moves into the Profile modal

The home screen no longer has the yellow CTA. The Profile modal gains a
new section below "Paired devices" with platform-aware visibility:

- iPhone / iPad / non-Mac platforms → hidden (can't install a `.app`)
- Tauri webview → hidden (you _are_ the .app)
- Mac browser with 0 paired Macs → main CTA with the value-prop blurb
- Mac browser with ≥1 paired Mac → compact "Install on another Mac" link

Copy moves from "Recording happens on your phone, the Mac app pastes here"
(no longer true) to "Receive clips from any device even when your browser is
closed" (the actual remaining advantage).

### No first-record toast

The post-recording UX (pop sound + local clipboard write + history append)
is enough. Don't add a one-shot "the text is in your clipboard, by the way
install the Mac app" toast — patronising, and the user who got far enough
to tap REC already understands what they did.

## Terminology consequences

Captured in [CONTEXT.md](../../CONTEXT.md):

- **Recorder** — any client with a REC button. Today: mobile PWA, desktop
  browser PWA, Tauri webview.
- **Receiver** — anything that gets Clips fan'd out to it via SSE and writes
  them to a local clipboard surface. Today: paired Tauri Macs only.
- **Device** — a row in the `devices` table = a registered Receiver = a
  paired Mac. The UI label "Paired devices" is reserved for this meaning.

## Future direction (not in this ADR)

The user wants every signed-in client to be both a Recorder and a Receiver
— i.e. a Clip recorded on the phone lands in the desktop browser's
clipboard too, even if no .app is installed. That requires:

1. PWA Sessions hold an SSE connection to `/events` while foregrounded.
2. The server fan-out keys off the user, not just the `devices` table.
3. The PWA listener calls `navigator.clipboard.writeText()` on each
   received Clip — needs a recent user gesture, so probably gated by a
   visible "Listening on this tab" indicator that the user must arm.

When that ships, "Receiver" widens to include browser tabs. The term
**"device"** must NOT widen with it — see CONTEXT.md for why.

## Alternatives considered

- **Keep `isDesktop` hide, add REC only inside Tauri.** Cleaner per-platform
  branching, but it cements the "you must install the .app to record from a
  Mac" position. With Web Audio and `navigator.clipboard.write` already
  working in browsers, that's friction without a reason.

- **Make the desktop-browser REC a "demo" / require sign-in.** The current
  bundle already requires `/me` for the recorder to function (auth gate on
  `/upload`), so demo mode would be a separate scope. Not pursued — the
  signed-in browser-on-Mac case is the actual user journey we want to fix
  today.

- **First-record toast nudging .app install.** Rejected — patronising, and
  the Profile-modal CTA is discoverable enough.
