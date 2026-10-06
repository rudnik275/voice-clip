# 0007 — Internal transcription endpoint for sibling services

**Status:** accepted 2026-10-06

The family-budget Telegram bot (same VPS, `rudnik275/family-budget`) needs voice
messages as text. Instead of a second OpenAI key, it reuses voice-clip's
transcription through `POST /transcribe` on a separate port
(`INTERNAL_TRANSCRIBE_PORT`, 8090 in prod, `src/internal-transcribe.ts`).

- **Auth is the network:** the port is not bound on the host and no Cloudflare
  Tunnel ingress points at it — only containers on `infra-net` reach
  `voice-clip:8090`. No shared secret across two projects' vaults.
- **No side effects:** no user, history, clipboard fan-out or quota — the
  public `/upload` would put family voice notes into the owner's history and
  Mac clipboard. Only `transcribeAudio` is reused (incl. `.oga` → `.ogg`, #159);
  cost is logged per call.
- Limit 5 MB per clip, like `/upload`.

Consequence: anything on `infra-net` can spend the OpenAI key through this
port — today that is only the owner's own services.
