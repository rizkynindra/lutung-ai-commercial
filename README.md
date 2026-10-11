# LUTUNG AI — MVP v1.0

Portal to discover, try and integrate LUTUNG AI technologies (spec: `PRD/LUTUNG_AI_MVP_PRD_v1.0.docx`).
One FastAPI app = server-rendered public pages + the backend/BFF (auth, trials, validation, rate limits, provider adapters).

```
app/main.py        routes: pages + /api/v1/*, upload validation, rate/concurrency limits, structured logs
app/db.py          SQLite: users, trial entitlements (atomic state machine), executions, consent, feedback
app/auth.py        Firebase ID-token verification (Google sign-in)
app/providers.py   server-side inference adapters (RunPod runsync shape; "mock" for dev)
app/registry.json  technology catalog — edit to add a service or change status (no restart needed)
```

## Run locally

```bash
python -m venv .venv && .venv/Scripts/pip install -r requirements.txt
```

```bash
LUTUNG_ENV=development LUTUNG_DEV_AUTH=1 LUTUNG_PROVIDER_DOCUMENT_DETECTION_URL=mock LUTUNG_PROVIDER_OCR_KTP_URL=mock .venv/Scripts/python -m uvicorn app.main:app --reload
```

Dev auth lets "Masuk dengan Google" prompt for an email instead of Firebase. It is ignored unless `LUTUNG_ENV=development`.

```bash
.venv/Scripts/python -m pytest -q tests
```

## Configuration (server env only — never in the browser bundle)

| Var | Purpose |
|---|---|
| `FIREBASE_PROJECT_ID`, `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN` | Google sign-in (web config is public; project ID is the token audience) |
| `LUTUNG_PROVIDER_<ADAPTER>_URL` / `_TOKEN` | Inference endpoint + key, e.g. `LUTUNG_PROVIDER_OCR_KTP_URL=https://api.runpod.ai/v2/<id>/runsync` |
| `LUTUNG_DB_PATH` | SQLite file (default `lutung.db`) |
| `LUTUNG_DISABLED` | Comma-separated slugs to force into maintenance (kill switch) |
| `LUTUNG_ENV`, `LUTUNG_DEV_AUTH` | Dev-only auth bypass |

## Operations

- **Disable a service:** set `"status": "maintenance"` in `registry.json` or add the slug to `LUTUNG_DISABLED`. Submissions are rejected before any provider call; the rest of the catalog keeps working.
- **Limits** (size, formats, megapixels, timeout, rate/min, concurrency) are per technology in `registry.json`.
- **Logs** are JSON lines on stdout: request ID, path, status, latency, technology, outcome, error code. No file bytes, OCR output or tokens.
- **Trial:** `AVAILABLE → RESERVED → CONSUMED`; provider failure/timeout releases it. A reservation older than `timeout_s + 60` is treated as abandoned and can be re-reserved.
- **Backup:** copy `lutung.db` with `sqlite3 lutung.db ".backup backup.db"`. Restore = replace the file and restart.

## Still open (from PRD §20 — needs owners, not code)

- Phase 0: confirm the real Document Detection / OCR KTP request + response contracts; adjust only `app/providers.py` and the docs examples in `registry.json`.
- Final file formats/limits, OCR KTP JSON schema, privacy notice legal review, hosting/domain, RunPod CPU vs VPS benchmark, budget alerts.
- Single instance assumed: rate limits are in-process and SQLite is local. Moving to multiple instances → Redis limiter + managed Postgres (SQL is portable).

## Deploy (lutung.ai.id on one Ubuntu VPS)

Files: `deploy/Caddyfile` (HTTPS + reverse proxy), `deploy/lutung.service` (systemd), `deploy/lutung.env.example`.

1. **DNS** (Sumopod DNS panel): `A  @  <VPS IP>` and `A  www  <VPS IP>`. Wait until `nslookup lutung.ai.id` returns the IP.
2. **Server setup** (as root, Ubuntu 22.04/24.04):
   ```bash
   apt update && apt install -y python3-venv git caddy sqlite3
   useradd --system --home /opt/lutung lutung && mkdir -p /var/lib/lutung && chown lutung /var/lib/lutung
   git clone <repo-url> /opt/lutung && cd /opt/lutung
   python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
   cp deploy/lutung.env.example /etc/lutung.env && chmod 600 /etc/lutung.env   # then fill in values
   cp deploy/lutung.service /etc/systemd/system/ && systemctl daemon-reload && systemctl enable --now lutung
   cp deploy/Caddyfile /etc/caddy/Caddyfile && systemctl reload caddy
   ufw allow OpenSSH && ufw allow 80,443/tcp && ufw enable
   ```
   Caddy obtains the Let's Encrypt certificate automatically once DNS points at the server.
3. **Firebase console** → Authentication → Settings → Authorized domains: add `lutung.ai.id`. Enable the Google provider.
4. **Check:** `curl https://lutung.ai.id/api/v1/health` and `journalctl -u lutung -f`.

**Update:** `cd /opt/lutung && git pull && .venv/bin/pip install -r requirements.txt && systemctl restart lutung`
(registry-only edits need no restart).

**Backup** (daily cron): `sqlite3 /var/lib/lutung/lutung.db ".backup /var/backups/lutung-$(date +\%F).db"` — copy off-server too.
