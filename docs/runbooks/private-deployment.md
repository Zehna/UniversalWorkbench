# Runbook — Private Self-Hosting Deployment

> Audience: the operator deploying Universal Workbench for private (single
> household / small team) use after Phase 5. Assumes a Linux host with Docker
> Engine + Compose plugin, a domain name, and basic shell comfort.

## 1. Prerequisites

- Docker Engine 24+ with the Compose v2 plugin (`docker compose version`).
- A domain pointing at the host (e.g. `workbench.example.com`).
- Ports 80/443 reachable for ACME HTTP-01 challenges.
- ~2 GB RAM free (limits are set in `deploy/docker/compose.prod.yml`).

## 2. Secrets (do this first)

Generate and store three values in a root-only `.env` file next to the
compose invocation (`chmod 0600 .env`):

```sh
# 32 random bytes, base64 — the vault master key (version 1).
node -e "console.log('1:' + require('node:crypto').randomBytes(32).toString('base64'))"
# Database password (32+ random characters).
node -e "console.log(require('node:crypto').randomBytes(24).toString('hex'))"
```

`.env` contents:

```text
POSTGRES_PASSWORD=<db password>
VAULT_MASTER_KEYS=1:<base64-32B>
TRUSTED_ORIGINS=https://workbench.example.com
```

Compose fails fast when any of these is missing — there are **no default
credentials** in the production file. Rotate the vault key with
`node scripts/vault-rekey.mjs` (records a `vault.rekey` audit entry), then
update `VAULT_MASTER_KEYS` to the new versioned keyring.

## 3. First boot

```sh
git checkout main   # after the Phase 5 release PR merges
docker compose -f deploy/docker/compose.prod.yml up -d --build
docker compose -f deploy/docker/compose.prod.yml ps
curl -fsS http://127.0.0.1:3000/health/live
```

Expected: all services `running (healthy)` except `migrate`/`config-check`
(`exited 0`). If `config-check` fails, a required secret is missing — fix
`.env` and retry.

## 4. Reverse proxy with HTTPS

Only the proxy publishes ports. Pick one:

### Option A — Caddy (recommended, automatic HTTPS)

```text
workbench.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

```sh
sudo systemctl reload caddy
curl -fsS https://workbench.example.com/health/live
```

### Option B — Nginx

```nginx
server {
    listen 443 ssl;
    server_name workbench.example.com;
    ssl_certificate /etc/letsencrypt/live/workbench.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/workbench.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";  # sync WebSocket
    }
}
```

Keep `SESSION_COOKIE_SECURE=true` (already set in prod compose) and confirm
`TRUSTED_ORIGINS` matches the public origin exactly.

## 5. Backup cron automation

Nightly unified backup (database dump + artifacts + encrypted vault
envelope with a checksummed manifest):

```cron
30 2 * * * cd /opt/workbench && DATABASE_URL=postgresql://workbench:***@127.0.0.1:5432/workbench node scripts/backup-create.mjs --out /var/backups/workbench/uw-backup-$(date +\%F).tar.gz --artifacts-dir /var/lib/docker/volumes/universal-workbench-prod_artifacts-data/_data >> /var/log/workbench-backup.log 2>&1
```

Prefer Docker-free DB access via a published loopback port or `docker exec`
against the postgres container. Retain 7–14 daily archives off-host
(`manifest.json` inside each archive carries per-file SHA-256 checksums).
Verify a fresh archive restores before trusting the cron:

```sh
node scripts/backup-restore.mjs --archive <file> --db-url <staging-url> --storage-dir /tmp/restore-check
```

## 6. Disaster recovery

1. Provision a clean host, install Docker, restore `.env` from the offline copy.
2. `docker compose -f deploy/docker/compose.prod.yml up -d postgres` (schema only).
3. Restore the latest verified archive:
   `node scripts/backup-restore.mjs --archive uw-backup-<date>.tar.gz --db-url <prod-url> --storage-dir <artifacts volume path>`.
   Integrity mismatches abort with a non-zero exit — never `--force` past them.
4. `up -d --build` the full stack, then run the automated drill against a
   staging target: `node scripts/test-restore-drill.mjs`.
5. Check `/api/diagnostics/readiness` (200 `ready`) and the recovery bundle;
   confirm vault `configured: true` with the restored keyring.

Recovery time objective with this flow is minutes (image pull + one restore
command); recovery point objective is the last cron archive.

## 7. Zero-downtime updates

```sh
git pull
docker compose -f deploy/docker/compose.prod.yml build app worker web migrate
docker compose -f deploy/docker/compose.prod.yml up -d --no-deps migrate
docker compose -f deploy/docker/compose.prod.yml up -d --no-deps worker app web
curl -fsS https://workbench.example.com/api/diagnostics/readiness
```

Migrations run before the new app/worker start; the old web keeps serving
until the new one is healthy. Roll back with `git checkout <prior-tag>` and
the same sequence (schema rollbacks are forward-only — restore from backup
if a migration must be undone).

## 8. Operate

- Health: `/health/live` (liveness), `/api/diagnostics/readiness` (gating).
- Recovery bundle (owner-authenticated): `/api/diagnostics/recovery-bundle`
  — attach it to bug reports; secrets are redacted by construction.
- Destructive actions (project/vault deletion) require explicit confirmation
  and are audit-logged (`project.delete`, `vault.secret.delete`).
- Logs: `docker compose logs app worker`; never paste raw logs containing
  `secret://` values — the repo gate `scripts/verify-no-secrets.mjs`
  enforces this on smoke logs.
