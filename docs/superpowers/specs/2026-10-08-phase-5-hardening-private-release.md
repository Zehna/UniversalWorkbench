# Phase 5 Design Spec: Hardening & Private Release

## 1. Goal & Architecture Scope

Phase 5 fulfills the Master Blueprint requirement: **Hardening & Private Release**.
After Phase 0–4 achieved the core north-star pipeline (`HTTP -> JSON -> AI -> Note -> Sync`), Phase 5 hardens the entire system for secure, reliable, and self-hosted private deployment by a single owner across multiple devices.

### Non-Goals

- No autonomous agentic loops or ReAct runtimes.
- No visual canvas or branching DAG workflows.
- No vector database or semantic RAG search.

---

## 2. Core Pillars

### Pillar 1: Upload & Artifact Security

- **Magic-Byte Sniffing:** Strictly detect MIME types based on file headers/signatures rather than client-reported headers or filename extensions.
- **Path Sanitization:** Reject path traversal (`..`, null bytes, control characters, leading slashes).
- **Integrity & Quotas:** Enforce sha256 checksum generation per artifact and maximum size boundaries.

### Pillar 2: Destructive Action & Authz Safeguards

- **Cascade Deletion Protection:** Explicit confirmation tokens for project/vault deletions.
- **Audit Logs:** Tamper-evident logging for critical operations (rekeying, deletions, auth session revocations).
- **IDOR Defense:** Strict owner boundary checks across all project endpoints.

### Pillar 3: Disaster Recovery & Automated Restore Drills

- **Unified Backup Archive (.tar.gz):** Contains PostgreSQL dump, file artifacts, and encrypted vault keyring metadata (without master key).
- **Automated Restore Drill:** Standalone CLI script verifying database restoration, relation integrity, and artifact hash verification in a clean throwaway environment.

### Pillar 4: Diagnostics & Redacted Recovery

- **Probes:** `/api/diagnostics/health` (liveness) and `/api/diagnostics/readiness` (database, storage, keyring checks).
- **Recovery Bundle:** Export system diagnostics filtered strictly through `redactSecrets`.

### Pillar 5: Production Private Deployment

- **Hardened Compose:** Rootless containers, memory/CPU constraints, isolated network bridge.
- **Runbooks:** Detailed guide for private VPS deployment with HTTPS reverse proxy, automated backup cron, and schema update procedures.
