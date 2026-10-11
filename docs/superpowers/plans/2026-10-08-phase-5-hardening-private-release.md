# Phase 5 Implementation Plan: Hardening & Private Release

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Branch: `phase-5-hardening-private-release`

---

### Task 1: Upload Security & Artifact Content Verification

- **Files:**
  - Create: `packages/artifacts/src/security.ts`
  - Modify: `packages/artifacts/src/index.ts`
  - Modify: `apps/server/src/routes/artifacts.ts`
  - Test: `packages/artifacts/test/upload-security.test.ts`
- **Requirements:**
  - Implement magic-byte verification for common types (png, jpeg, webp, pdf, json, text).
  - Path traversal & filename sanitization (`sanitizeFilename`).
  - Enforce strict size limits and sha256 checksums.
- [ ] **Step 1:** Write RED unit tests for magic-byte verification and filename sanitization.
- [ ] **Step 2:** Implement security functions in `packages/artifacts/src/security.ts`.
- [ ] **Step 3:** Wire into `apps/server/src/routes/artifacts.ts`.
- [ ] **Step 4:** Run GREEN: `npm test -w @uw/artifacts && npm run verify:workspaces && npm run typecheck`.
- [ ] **Step 5:** Commit: `feat(security): enforce magic-byte sniffing and upload path sanitization`.

---

### Task 2: Authz & Destructive Action Safeguards

- **Files:**
  - Modify: `apps/server/src/routes/projects.ts`
  - Modify: `apps/server/src/routes/vault.ts`
  - Test: `apps/server/test/destructive-actions.integration.test.ts`
- **Requirements:**
  - Guard destructive project and vault secret deletion with confirmation checks.
  - Record audit log entries on deletion and vault rekey events.
  - Verify IDOR protection: accessing another owner's resources must return 404 (concealment).
- [ ] **Step 1:** Write RED integration tests for destructive actions and cross-owner access.
- [ ] **Step 2:** Implement safeguards and audit logging in server routes.
- [ ] **Step 3:** Run GREEN: `npm test -w @uw/server`.
- [ ] **Step 4:** Commit: `security: add destructive action guards and ownership audit`.

---

### Task 3: Unified Backup Engine & CLI

- **Files:**
  - Create: `packages/storage/src/backup.ts`
  - Create: `scripts/backup-create.mjs`
  - Test: `apps/server/test/backup-create.test.ts`
- **Requirements:**
  - Stream PostgreSQL dump + artifact storage + encrypted vault envelope into a single compressed tarball.
  - Manifest includes timestamp, version, and file checksums.
- [ ] **Step 1:** Write RED tests for backup creation and manifest generation.
- [ ] **Step 2:** Implement backup generator and CLI script.
- [ ] **Step 3:** Run GREEN: `npm test -w @uw/server -- backup-create.test.ts`.
- [ ] **Step 4:** Commit: `feat(backup): add unified backup generation engine and CLI`.

---

### Task 4: Automated Restore Drill & Verification Script

- **Files:**
  - Create: `scripts/backup-restore.mjs`
  - Create: `scripts/test-restore-drill.mjs`
- **Requirements:**
  - Restore PostgreSQL database and artifacts from backup tarball into target environment.
  - Standalone automated drill script: seed dummy project -> backup -> restore to clean DB -> assert data integrity.
- [ ] **Step 1:** Implement restore CLI and automated drill test.
- [ ] **Step 2:** Test drill locally against PostgreSQL.
- [ ] **Step 3:** Commit: `feat(backup): add automated restore drill and verification script`.

---

### Task 5: System Diagnostics & Redacted Recovery Bundle

- **Files:**
  - Create: `apps/server/src/routes/diagnostics.ts`
  - Modify: `apps/server/src/app.ts`
  - Create: `apps/web/src/settings/DiagnosticsView.tsx`
  - Test: `apps/server/test/diagnostics-api.integration.test.ts`
- **Requirements:**
  - Endpoint `/api/diagnostics/health` and `/api/diagnostics/readiness` (DB ping, storage access, vault status).
  - Endpoint `/api/diagnostics/recovery-bundle` returning redacted JSON diagnostics.
  - Basic diagnostics UI in web settings.
- [ ] **Step 1:** Write RED tests for diagnostics endpoints.
- [ ] **Step 2:** Implement diagnostics routes and web UI view.
- [ ] **Step 3:** Run GREEN: `npm test -w @uw/server && npm test -w @uw/web`.
- [ ] **Step 4:** Commit: `feat(diagnostics): add readiness checks and redacted recovery bundle export`.

---

### Task 6: Accessibility, PWA Resilience, & Large Payload Handling

- **Files:**
  - Modify: `apps/web/src/...`
  - Test: `apps/web/test/accessibility-performance.test.tsx`
- **Requirements:**
  - Virtualize large note/artifact lists.
  - Keyboard navigation and ARIA label pass on main interactive screens.
  - Offline banner & resilience handling on execution disconnects.
- [ ] **Step 1:** Write RED component tests for keyboard access and large payload display.
- [ ] **Step 2:** Implement optimizations and accessibility improvements.
- [ ] **Step 3:** Run GREEN: `npm test -w @uw/web && npm run typecheck -w @uw/web`.
- [ ] **Step 4:** Commit: `fix(web): harden accessibility, large payload rendering, and PWA resilience`.

---

### Task 7: Production Deployment Hardening, Runbook, & Final Phase 5 Gate

- **Files:**
  - Create: `deploy/docker/compose.prod.yml`
  - Create: `docs/architecture/phase-5.md`
  - Create: `docs/runbooks/private-deployment.md`
  - Modify: `README.md`
- **Requirements:**
  - Rootless containers, memory/CPU bounds, isolated network.
  - Runbook for self-hosting with reverse proxy (Caddy/Nginx) and backup cron.
  - Run full validation gate:
    `npm ci && npm run verify:workspaces && npm run lint && npm run typecheck && npm test && npm run build && node scripts/test-restore-drill.mjs && node scripts/verify-no-secrets.mjs`
- [ ] **Step 1:** Create production Docker compose and deployment runbook.
- [ ] **Step 2:** Write `docs/architecture/phase-5.md` and update `README.md`.
- [ ] **Step 3:** Run full validation gate.
- [ ] **Step 4:** Commit: `docs: close phase 5 hardening and private release`.
- [ ] **Step 5:** Open Pull Request to `main`.
