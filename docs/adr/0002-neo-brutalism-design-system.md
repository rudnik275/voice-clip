# 0002 — Visual design system: Neo-Brutalism + synthesized UI sounds

Status: accepted (2026-05-24)

## Context

The PWA shipped in dark "Liquid Glass" — backdrop-blurred translucent
surfaces, mesh-gradient ambient background, conic-gradient aura behind a
single round record button. Visually competent but indistinguishable
from any 2018–2024 macOS-inspired app: the same vocabulary every other
indie tool has been using for six years.

We wanted the home screen of the PWA to **announce itself** — when the
user glances at their phone's home screen, the icon and the first
launched frame should be obviously "voice-clip" and not "another sleek
dark app." The product is single-purpose (one big record button), so the
visual language carries more weight than usual: there are no features to
hide behind.

We also wanted **audio feedback** for the recording lifecycle. Web Audio
is available everywhere we ship, no `.mp3` assets means no SW cache
weight and no third-party files to license.

## Decision

### Visual language: Neo-Brutalism (cream + red + violet)

Adopted across `web/style.css`:

- Background: cream `#FFFDF5` with subtle dot-grid texture (24px grid,
  12% black, mask-faded toward edges)
- Foreground: rich black `#09090B`, **not** pure `#000000`
- Primary CTA (record button): hot red `#FF6B6B`, 380×380px circle,
  5px solid black border, 12px hard offset shadow (no blur)
- Topbar pills: white history button (rotated -2°), violet user pill
  (rotated +1.5°), each with 3px border + 5px offset shadow
- "REC" sticker: yellow `#FFD93D`, rotated 14°, sits on the button
- All interactions use **mechanical press**: on `:active` the element
  translates `(N, N)px` into its shadow position and the shadow drops
  to 0 — no scale, no blur, no spring; instant
- Typography: **Space Grotesk** (Google Fonts, weights 500/600/700) for
  everything — geometric sans matches the rest of the language
- Modals (history, profile): full-bleed cream sheets with white header
  bar, 3px black bottom border, slide-up + fade entrance

JS state hooks unchanged — `style.css` exposes the same `.recording`,
`.busy`, `.paused`, `.unread`, etc. classes. `app.ts` integration is
purely additive (imports + hook calls). No selectors renamed.

### Voice-reactive halo (recording state)

While `.recording`, four properties are driven by the existing
`--voice-level` CSS variable that `app.ts` already sets ~30 times/sec
from the mic RMS:

1. **Button scale** — `1 + level * 0.07` (max +7%)
2. **Button tilt** — `level * -1.2deg`
3. **Yellow halo ring** — `box-shadow: 0 0 0 calc(2px + level * 20px) yellow`
   grows around the button as you talk louder
4. **Black outline ring** — `box-shadow: 0 0 0 calc(6px + level * 22px) black`
   stays 4px thicker than the halo, framing it so the silhouette stays
   crisp regardless of background
5. **Offset shadow** — main hard shadow grows from 12 to 22px on peaks

The "ON AIR" sticker also tilts further (-4°) and scales (+15%) on
peaks. Transitions are 90–110ms cubic-bezier(0.4, 0, 0.6, 1) — fast
and snappy, no organic spring. Brutalist motion is mechanical.

### UI sounds: Web Audio synthesis (no assets)

New module `web/sounds.ts`. Eight synthesized sounds, all generated
on-demand from `OscillatorNode` + filtered noise bursts:

| Trigger | Sound |
|---------|-------|
| Start recording | Low square wave 90→48Hz + high-passed noise burst — "THUNK" |
| Stop recording | Short sine 550Hz + noise — release click |
| Pause | Single sine 1500Hz, 18ms |
| Resume | Double tick (1500 → 1900Hz, 80ms apart) |
| Transcription done | Sine 880Hz + sine 1320Hz (perfect fifth) — mini-bell |
| Any error toast | Triple low square 220Hz, staccato — buzzer |
| History clip copy | Sine 800→500Hz pop pair |
| Modal open | Filtered noise sweep 2000→400Hz + bright sine tick |

All envelopes are hard ADSR (1–5ms attack, exponential release).
Synthetic, mechanical, no reverb — matches the visual language.

`AudioContext` is lazy (created on first user gesture — iOS requirement
to unlock audio). Mute state persisted in `localStorage` as
`voice-clip:sounds`. Toggle UI lives in the profile menu, default ON.
Bundle cost: ~3KB minified, no network requests.

## Consequences

### What this gives us

- **Distinctive** — the app announces itself; not visually
  interchangeable with the dark-glass swarm
- **Accessible** — light mode, high contrast (#FFFDF5 + #09090B easily
  clears WCAG AAA for body text), no blur dependency (Brutalism reads
  fine on low-end devices)
- **Cheap motion** — `transform` + `box-shadow` only; no
  `backdrop-filter` to fight on iOS, no organic spring physics to tune
- **Zero asset weight** for sounds — no `.mp3`/`.wav` to cache, no
  licensing, no CDN

### What it costs

- **Polarising** — Brutalism is a strong opinion. Some users will dislike
  it on first sight (no opt-out to a quieter theme today)
- **Light-only** — no dark mode planned; the design loses identity if
  inverted (the cream background is the whole point)
- **Font dependency** — Space Grotesk loaded from Google Fonts. Adds one
  external request; mitigated by `<link rel="preconnect">` to
  `fonts.gstatic.com`. Fallback to system sans is acceptable but loses
  geometry
- **Auth pages still old** (`login.html`, `signup.html`,
  `access-denied.html`, `signup-needed.html`) — separate self-contained
  inline styles, tracked in #53. First impression for unauthed users
  is currently inconsistent

## Alternatives considered

Three other directions were prototyped before settling:

| Style | Why rejected |
|-------|--------------|
| **Spatial Glass** (VisionOS-inspired evolution of current Liquid Glass with aurora-mesh background, multi-layer frosted orb) | Too similar to current state — would feel like a polish pass, not a redesign |
| **Modern Pro** (Linear/Arc/Raycast style with bento grid, hairline borders, indigo accent) | Information-dense layout doesn't suit the single-button product. The PWA has nothing to put in stat cards |
| **Neumorphism** (soft clay light mode, extruded shadows) | Too muted to "announce itself" on the home screen; pleasant but forgettable |
| **Claymorphism** (puffy 3D pastel orb with violet→pink gradient) | Visually rich but feels childlike; doesn't match the dictation-tool intent |

Within Brutalism, three palettes were compared:

| Palette | Outcome |
|---------|---------|
| **Cream + Red + Violet** (original) | ✅ Selected — warmest, most "indie tool" |
| **Electric Dark** (black bg, acid yellow CTA, hot pink, cyan) | Tech/cyberpunk vibe, but too aggressive for everyday dictation |
| **Pastel Candy** (warm cream, peach/blue/mint with navy borders) | Friendly but loses CTA hierarchy — the peach button doesn't read as "primary action" |
| **Mono Editorial** (newspaper cream, black button, single tomato accent) | High-fashion but distant — the inverted CTA feels like a "do not press" |

Process artifacts (HTML prototypes, side-by-side composites, screenshots)
were ephemeral and lived in the session scratch directory — not
preserved.

## References

- PR: https://github.com/rudnik275/voice-clip/pull/54
- Follow-up issue: #53 (restyle auth pages)
- Code: `web/style.css`, `web/sounds.ts`, `web/home.html`
- Hook integration: `web/app.ts` (imports + calls only, no logic changes)
