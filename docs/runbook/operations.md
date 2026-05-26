# Operations runbook

Day-to-day ops for voice-clip on the VPS (`deploy@46.62.229.131`, public
`https://voice.rudifamily.uk`). Read alongside:

- `docs/runbook/litestream-restore.md` — restore the sqlite from S3
- `docs/runbook/desktop-updater-setup.md` — one-time Tauri Ed25519 setup
- `docs/adr/0003-monetization-scaffold.md` — why the auth + quota model is shaped
  the way it is

The app reads `/opt/voice-clip/.env` on the VPS. CI deploys roll the container
on every merge to `master` (see `.github/workflows/server-deploy.yml`).

---

## Required env vars (set on the VPS)

| Var                          | Required | Purpose |
| ---------------------------- | -------- | ------- |
| `OPENAI_API_KEY`             | yes      | Transcription |
| `GOOGLE_OAUTH_CLIENT_ID`     | yes      | Google sign-in |
| `GOOGLE_OAUTH_CLIENT_SECRET` | yes      | Google sign-in |
| `PUBLIC_URL`                 | yes      | Used to build OAuth `redirect_uri` and invite URLs |
| `VOICE_CLIP_ALLOWED_EMAILS`  | yes      | Seed list for the DB `allowed_emails` table on boot. Past it, friends join via invite links — no redeploy needed |
| `OWNER_EMAIL`                | optional | When set, that email's session is `is_owner: true` → sees the **Generate invite link** button in the profile modal AND can POST `/admin/invites` without an `X-Admin-Token` |
| `ADMIN_TOKEN`                | optional | Alt path for ops scripts to reach `/admin/*` without a browser session. `openssl rand -hex 24` |
| `LITESTREAM_S3_*` × 4        | yes      | S3 backup sidecar — see `.env.example` |

After editing the VPS `.env`, restart the container:
```sh
ssh deploy@46.62.229.131 'cd /opt/voice-clip && sudo -n docker compose -f docker-compose.prod.yml restart voice-clip'
```

The Free-tier monthly clip cap is **30** by default. It's not env-wired yet
(passed as the `freeTierMonthlyLimit` dep in `src/server.ts`); if you want
to override on the VPS, add a config plumb-through to `src/config.ts`.

---

## Inviting friends

### Via UI (when `OWNER_EMAIL` is set)
1. Open the PWA → user pill → profile modal
2. Bottom: **Invite a friend → Generate invite link**
3. URL is copied to clipboard
4. Send to friend — single-use, 10-min cookie window

### Via curl (when `ADMIN_TOKEN` is set)
```sh
ADMIN_TOKEN=… curl -fsS -X POST \
  -H "X-Admin-Token: $ADMIN_TOKEN" \
  https://voice.rudifamily.uk/admin/invites
# → { "token": "<64-hex>", "url": "https://voice.rudifamily.uk/invite/<token>" }
```

### What the friend sees
Opens the link → Google OAuth → lands on `/` signed in. Their email is added
to `allowed_emails` with `added_via='invite'` and the invite row is marked
used. Re-opening the same link returns **410 Gone**.

---

## Plan promotion (Stripe not wired up yet)

Three plans live in `user_plans.plan`:

| plan | monthly cap | per-clip cap | when to use |
|---|---|---|---|
| `free` | 30 clips | 5 min | default for everyone |
| `pro`  | 50 clips | 5 min | paying user (manual until Stripe lands) |
| `unlimited` | none | none | owner-comp / household; never for paid users |

The container image ships without `sqlite3`, so run all DB pokes via
`docker exec voice-clip bun -e '…'` — the `bun:sqlite` binding is
always available and matches the running schema.

```sh
# Find the user id
ssh deploy@46.62.229.131 'docker exec voice-clip bun -e "
  import {Database} from \"bun:sqlite\";
  const db = new Database(\"/data/voice-clip.sqlite\");
  console.log(JSON.stringify(db.query(\"SELECT id, email, name FROM users\").all(), null, 2));
"'

# Promote — set PLAN to one of: pro, unlimited, free
PLAN=pro UID=u_… ssh deploy@46.62.229.131 "docker exec voice-clip bun -e \"
  import {Database} from 'bun:sqlite';
  const db = new Database('/data/voice-clip.sqlite');
  db.prepare('INSERT INTO user_plans (user_id, plan, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET plan = excluded.plan, updated_at = excluded.updated_at').run('$UID', '$PLAN', Date.now());
  console.log(JSON.stringify(db.query('SELECT plan FROM user_plans WHERE user_id = ?').get('$UID')));
\""
```

The profile chip refreshes on the next `/me` call:
- `free` → "Free plan · N / 30 this month"
- `pro`  → "Pro plan · N / 50 this month"
- `unlimited` → "Unlimited · No monthly cap"

Demote back to `free` by re-running with `PLAN=free`.

---

## Observability (#55)

Both client-side JS crashes (`window.onerror`, `unhandledrejection`,
`MediaRecorder.onerror`, upload + network failures) and server-side 5xx
land in the `errors` table. Transcription failures additionally retain the
raw audio under `/data/failed-audio/<userId>/<errorId>.<ext>` for 14 days,
so you can re-run them.

### List recent unresolved errors
```sh
curl -fsS https://voice.rudifamily.uk/admin/errors \
  -H "X-Admin-Token: $ADMIN_TOKEN" | jq
```

### Include resolved
```sh
curl -fsS "https://voice.rudifamily.uk/admin/errors?all=1" \
  -H "X-Admin-Token: $ADMIN_TOKEN" | jq
```

### Replay a transcription error against the saved blob
```sh
curl -fsS -X POST "https://voice.rudifamily.uk/admin/errors/$ID/replay" \
  -H "X-Admin-Token: $ADMIN_TOKEN"
# → { ok: true, text: "…", usage: {...} } AND marks the error row resolved
```

If the audio file got purged (14-day window), the endpoint returns 410.

---

## Reading cost (the bit that was hidden from the UI in #60)

The `costs` table holds a per-user + aggregate (sentinel `__aggregate__`)
cumulative spend. The `history` table records per-clip `cost_usd`.

```sh
# Totals
ssh deploy@46.62.229.131 \
  'sudo -n docker exec voice-clip sqlite3 -header -column /data/voice-clip.sqlite \
     "SELECT user_id, total_usd FROM costs ORDER BY total_usd DESC"'

# This month per user
ssh deploy@46.62.229.131 \
  "sudo -n docker exec voice-clip sqlite3 -header -column /data/voice-clip.sqlite \
     \"SELECT u.email, ROUND(SUM(h.cost_usd), 4) AS usd, COUNT(*) AS clips \
       FROM history h JOIN users u ON u.id = h.user_id \
       WHERE strftime('%Y-%m', h.ts/1000, 'unixepoch') = strftime('%Y-%m', 'now') \
       GROUP BY h.user_id\""
```

---

## Quick health checks

```sh
curl -fsS https://voice.rudifamily.uk/version          # → vNN
curl -fsSI https://voice.rudifamily.uk/icons/icon-192.png | head -1
curl -fsS https://voice.rudifamily.uk/pro | grep -c "Upgrade"   # >0 = page alive
ssh deploy@46.62.229.131 \
  'sudo -n docker inspect --format "{{.State.Health.Status}}" voice-clip'
```

---

## Tauri desktop releases

To ship the bundled .dmg for a desktop version bump:
```sh
git tag desktop-v0.3.0 && git push --tags
```
`.github/workflows/tauri-release.yml` builds a universal .dmg, signs
`latest.json` with the Ed25519 key from GH secrets, publishes to GitHub
Releases. The voice-clip server's `/desktop/update.json` 302s to the
latest GH Releases asset, so installed apps pick up the update on next
launch — no client change.

**Warning if you make the repo private:** GitHub Releases on private
repos require auth to download. Today's setup will 404 the Tauri updater.
Fix BEFORE going private — see `docs/adr/0003-monetization-scaffold.md`
for options.
