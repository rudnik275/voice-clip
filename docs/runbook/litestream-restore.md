# Litestream Restore Runbook

Operator guide for recovering the voice-clip SQLite database from Hetzner Object Storage using Litestream.

---

## Pre-conditions

- Hetzner Object Storage bucket is accessible (bucket name and endpoint are set in `.env`).
- `/opt/voice-clip/.env` contains valid values for all four `LITESTREAM_S3_*` variables:
  - `LITESTREAM_S3_BUCKET`
  - `LITESTREAM_S3_ENDPOINT`
  - `LITESTREAM_S3_ACCESS_KEY_ID`
  - `LITESTREAM_S3_SECRET_ACCESS_KEY`
- Docker is installed on the VPS and the litestream image can be pulled.
- You have SSH access to the VPS.

---

## Step-by-step

### 1. SSH into the VPS

```
ssh root@46.62.229.131
```

### 2. Stop the app container

The app must be stopped before restore to avoid file conflicts. The litestream sidecar may keep running — it holds only a read-only mount and will gracefully handle the db disappearing momentarily.

```
cd /opt/voice-clip && docker compose -f docker-compose.prod.yml stop voice-clip
```

Verify it is stopped:

```
docker compose -f docker-compose.prod.yml ps voice-clip
```

Expected: `State` is `exited` or the container is absent.

### 3. Run the restore script

The script is idempotent — it is safe to run twice. If a database file already exists it will be backed up with a timestamp suffix before restore.

```
bash /opt/voice-clip/scripts/litestream-restore.sh
```

The script will:
1. Check that the voice-clip container is not running (exits with error if it is).
2. Back up any existing `voice-clip.sqlite` to `voice-clip.sqlite.bak.<unix-timestamp>`.
3. Run `litestream restore -if-replica-exists` — downloads the latest snapshot + WAL segments from S3.
4. Run `PRAGMA integrity_check` — exits with error if the result is not `ok`.
5. Print a confirmation message.

If the bucket has no replica yet (first-ever deploy, no backup uploaded), the script exits cleanly with an informational message — nothing is corrupted.

### 4. Verify data

```
sqlite3 /opt/voice-clip/data/voice-clip.sqlite 'PRAGMA integrity_check'
```

Expected output: `ok`

Check that key data is present:

```
sqlite3 /opt/voice-clip/data/voice-clip.sqlite 'SELECT count(*) FROM users'
```

### 5. Start the app

```
cd /opt/voice-clip && docker compose -f docker-compose.prod.yml up -d
```

Check logs to confirm the server is healthy:

```
docker logs -f voice-clip
```

---

## Recovery time estimate

- SQLite database ~10–50 MB: approximately 30 seconds – 2 minutes over a typical VPS network link.
- Larger databases or slow S3 endpoints may take longer. The restore uses streaming so memory usage is bounded.

---

## Troubleshooting

| Symptom | Action |
|---------|--------|
| `ERROR: voice-clip container is still running` | Run `docker compose -f /opt/voice-clip/docker-compose.prod.yml stop voice-clip` then re-run the script. |
| `integrity_check` fails | The downloaded file is corrupt. Check litestream logs, try restoring an older snapshot by running litestream restore with explicit `-timestamp` flag. |
| `no replica exists` info message | No backup has been uploaded yet — start the app normally (fresh deploy). |
| S3 auth error during restore | Verify `LITESTREAM_S3_ACCESS_KEY_ID` and `LITESTREAM_S3_SECRET_ACCESS_KEY` in `/opt/voice-clip/.env` match the Hetzner Console credentials. |
| Wrong endpoint | `LITESTREAM_S3_ENDPOINT` must be the full HTTPS URL, e.g. `https://fsn1.your-objectstorage.com`. |

---

## Architecture notes

- The `voice-clip-litestream` sidecar runs alongside the main `voice-clip` container (see `docker-compose.prod.yml`).
- The sidecar mounts `./data` **read-only** — it never writes to the data dir, only reads the SQLite WAL file.
- Litestream config lives at `litestream.yml` (repo root), mounted into the sidecar at `/etc/litestream.yml`.
- Both bucket and endpoint are shared with `valorant-comunity-bot`; each app writes under its own path prefix (`voice-clip/voice-clip.sqlite` vs `valorant-bot/data.db`).
- WAL retention is 7 days (`168h`); snapshots are taken every 24 hours.
- Stopping the main `voice-clip` container does **not** interrupt the sidecar — in-flight WAL frames continue to replicate until the litestream container is also stopped.

---

## Related

- Litestream configuration: `litestream.yml` (repo root)
- Docker Compose with litestream sidecar: `docker-compose.prod.yml`
- Restore script source: `scripts/litestream-restore.sh`
- Hetzner Object Storage shared bucket: `slotrankerbackups`
