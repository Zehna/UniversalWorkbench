# Phase 5 Architecture — Hardening & Private Release

> Implementation reference for the `phase-5-hardening-private-release`
> branch. Phase 5 closes the private-release boundary: upload security,
> destructive-action safeguards, unified backup/restore with automated
> drills, system diagnostics, resilient accessible web UI, and hardened
> production deployment. The release is complete when the Task 7 full gate
> passes on one final commit.

## 1. Upload security & artifact content verification (`@uw/artifacts`)

`packages/artifacts/src/security.ts` is the single authority for upload
validation; `ArtifactService.create` enforces it (defense in depth) and
`apps/server/src/routes/artifacts.ts` enforces it at the edge:

| Helper                                       | Guarantee                                                                                                                                                |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sniffMimeType(bytes)`                       | Magic-byte detection for png, jpeg, webp, pdf; structural detection for json (parse-verified) and text (strict UTF-8, no NUL). `null` for empty/unknown. |
| `verifyMimeType(bytes, declared)`            | Strict equality of sniffed vs declared (normalized) type; unsupported types always fail.                                                                 |
| `sanitizeFilename(name)`                     | Strips traversal, NUL/controls, leading dots; unsafe chars become `_`; dot-only/empty falls back to `file`; 255-char cap preserving extension.           |
| `computeSha256Hex` / `assertSizeWithinLimit` | Checksums and bounds (`MAX_ARTIFACT_BYTES` 10 MiB, `MAX_INLINE_JSON_BYTES` 512 KiB).                                                                     |
| `validateArtifactUpload`                     | One-shot size + content + checksum + filename validation.                                                                                                |

Downloads send a sanitized `Content-Disposition` filename plus `nosniff`.

## 2. Authz & destructive-action safeguards

- `DELETE /projects/:projectId` requires `{ confirm: <projectId> }`
  (400 `CONFIRMATION_REQUIRED` otherwise); ownership is checked first so
  cross-owner access stays 404 (`ProjectNotFoundError` concealment).
- `DELETE /vault/:name` requires `?confirm=<name>` with the same
  existence-first ordering.
- `ProjectService.delete` soft-deletes (`deleted_at`, consistent with sync
  tombstones) and audits `project.delete`; vault deletion audits
  `vault.secret.delete` (wired through `app.ts`/`composition.ts`); the
  `vault-rekey.mjs` operator script best-effort audits `vault.rekey`.

## 3. Unified backup format (`@uw/storage`)

`packages/storage/src/backup.ts` builds a gzip+USTAR archive (hand-rolled,
zero new dependencies, `tar tzf`-compatible, USTAR prefix-field support for
148-char storage keys):

```text
database.sql            plain pg_dump output
artifacts/<key>         files walked from the artifacts dir (symlinks skipped)
vault/envelope.json     { format, version, keyVersions[], rows[] } — hex
                        iv/ciphertext/authTag only; no key bytes, no plaintext
manifest.json           { format: "uw-backup", version: 1, createdAt,
                          database, artifacts[], vault, files[] } with
                        per-file { path, sha256, sizeBytes }
```

`createBackupArchive` / `readBackupArchive` / `verifyBackupIntegrity`
(checks every checksum) / `collectArtifactFiles` are shared by
`scripts/backup-create.mjs` (pg_dump + encrypted-column reads; the keyring
is never loaded) and `scripts/backup-restore.mjs` (verify-first, schema
wipe incl. `drizzle` bookkeeping, psql replay, artifact + vault restore).
`scripts/test-restore-drill.mjs` runs the full seed → backup → tamper
negative → restore → assert loop (10 checks) against throwaway databases.

## 4. Diagnostics & recovery bundle (`apps/server`)

`apps/server/src/routes/diagnostics.ts`, mounted at `/diagnostics` and
`/api/diagnostics`:

| Endpoint               | Auth  | Behavior                                                                                                                                                                                                           |
| ---------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /health`          | no    | Liveness `{ status: "ok" }`.                                                                                                                                                                                       |
| `GET /readiness`       | no    | DB `select 1` ping, storage write/read/delete probe, vault keyring state. Gates on DB + storage (vault reported, non-gating); 200 `ready` / 503 `not_ready`.                                                       |
| `GET /recovery-bundle` | owner | `buildRecoveryBundle` redress via `redactSecrets`: migration IDs, queue pending/claimed, sync counts, table counts, vault config + row count, node/platform. Per-field fail-open (`null`), never env/key material. |

## 5. Web resilience & accessibility (`apps/web`)

- `lib/VirtualizedList` — windowed rendering (explicit
  container/item heights + overscan) for notes and projects lists.
- `lib/TabList` — APG tabs (tablist role, roving tabindex,
  arrows/Home/End); used by the App and project tab groups.
- `lib/ConfirmDialog` — `alertdialog` with focus trap, Escape, and focus
  restoration; guards local-secret deletion.
- `lib/OfflineBanner` — `online`/`offline`-driven banner in the App shell.
- `ExecutionStatus` — payloads over 4000 chars truncate behind an
  `aria-expanded` expander; polling pauses offline and refreshes on reconnect.
- `settings/DiagnosticsView` — health/checks display plus authenticated
  recovery-bundle download, as a third Workbench tab.

## 6. Production deployment

`deploy/docker/compose.prod.yml` (validated with `docker compose config`):
isolated bridge network with no published database port, per-service
CPU/memory bounds, `unless-stopped` restart (one-shot migrate/config-check),
read-only root filesystem + `tmpfs` for app/worker (images already run as
non-root `node` / `nginx-unprivileged`), and fail-fast required secrets
(`POSTGRES_PASSWORD`, `VAULT_MASTER_KEYS`, `TRUSTED_ORIGINS` — no defaults).
Operations live in `docs/runbooks/private-deployment.md` (Caddy/Nginx HTTPS,
backup cron, disaster recovery, zero-downtime updates).

## 7. Release gate (Task 7)

```sh
npm ci && npm run verify:workspaces && npm run lint && npm run typecheck \
  && npm test && npm run build && node scripts/test-restore-drill.mjs \
  && node scripts/verify-no-secrets.mjs <smoke-log>
```

`verify-no-secrets.mjs` scans Docker/smoke logs for credential canaries
(session cookies, `secret://` values). DB-backed suites need
`TEST_DATABASE_URL`; the drill needs local PostgreSQL with createdb
privilege. Known environment limits (documented, not release blockers):
root `npm run typecheck` is slow (scoped workspace typechecks cover every
touched package); DB suites fail at import without a database.
