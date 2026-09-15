# Phase 1 — Project & Data Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first trustworthy product data layer: built-in owner authentication, Projects, immutable Document revisions, immutable Artifacts backed by a replaceable storage interface, and a single Action Layer for all state-changing API work.

**Architecture:** Keep the modular monolith established in Phase 0. Domain packages own interfaces and invariants; `@uw/database` implements PostgreSQL repositories with Drizzle; `@uw/server` composes repositories/services and exposes runtime-validated HTTP routes; `@uw/web` adds first-run/login/project/note UX. Phase 1 is server-authoritative; local-first SQLite/sync begins only in Phase 2.

**Tech Stack:** Node.js 24.21.0, TypeScript, Express 5, React 19/Vite 8 PWA, PostgreSQL 17, Drizzle ORM 0.45.2, Zod 4, Vitest 5, Node `crypto.argon2`/`randomBytes`/`timingSafeEqual`, local filesystem artifact storage.

**Spec:** `docs/superpowers/specs/2026-09-15-universal-workbench-design.md`

## Global Constraints

- Server DB is PostgreSQL only in production.
- Drizzle remains behind repository interfaces.
- First-run creates one built-in owner; public signup stays disabled.
- Passwords use Argon2id; plaintext passwords and raw session tokens never enter logs or DB rows.
- State-changing HTTP routes must pass through the Action Layer.
- Documents are mutable only by appending immutable `DocumentRevision` rows.
- Artifact metadata and bytes are immutable after creation.
- Phase 1 implements local filesystem storage only; the interface must permit an S3-compatible implementation later.
- Every untrusted HTTP boundary uses runtime schemas.
- No sync engine, WebSocket durable protocol, AI, workflow engine, arbitrary uploads, plugin/MCP runtime, Redis, or server-side SQLite in Phase 1.
- Existing Phase 0 CI gates remain mandatory and must stay green.

---

## File Structure

Create domain packages with focused responsibilities:

```text
packages/
  auth/
    src/password.ts          Argon2id hashing/verification
    src/session.ts           random session token + SHA-256 digest
    src/repository.ts        owner/session repository interface
    src/service.ts           setup/login/logout/session service
  core/
    src/action.ts            Action Layer executor + audit interface
    src/projects.ts          Project service + repository interface
  documents/
    src/model.ts             note document/revision types
    src/repository.ts        repository interface
    src/service.ts           create/update/read/list + conflict invariant
  storage/
    src/backend.ts           StorageBackend interface
    src/local-filesystem.ts  atomic local filesystem backend
  artifacts/
    src/model.ts             immutable artifact model
    src/repository.ts        repository interface
    src/service.ts           checksum/store/persist/read orchestration

packages/database/
  src/schema.ts              Phase 1 Drizzle tables
  src/migrate.ts             explicit migration runner
  src/repositories/*.ts      PostgreSQL implementations
  drizzle/0000_phase1.sql    deterministic initial domain migration

packages/contracts/src/
  auth.ts
  project.ts
  document.ts
  artifact.ts
  common.ts

apps/server/src/
  composition.ts             instantiate repos/services/storage/action layer
  middleware/auth.ts         resolve server-side session
  middleware/validate.ts     Zod request boundary helper
  routes/setup.ts
  routes/auth.ts
  routes/projects.ts
  routes/documents.ts
  routes/artifacts.ts

apps/web/src/
  api/client.ts
  auth/AuthGate.tsx
  auth/SetupOwner.tsx
  auth/Login.tsx
  projects/ProjectList.tsx
  projects/ProjectWorkspace.tsx
  documents/NoteEditor.tsx
```

No file should become a generic dumping ground. Repository implementations stay in `@uw/database`; domain packages must not import Drizzle.

---

### Task 1: Phase 1 contracts and workspace boundaries

**Files:**
- Create: `packages/contracts/src/common.ts`
- Create: `packages/contracts/src/auth.ts`
- Create: `packages/contracts/src/project.ts`
- Create: `packages/contracts/src/document.ts`
- Create: `packages/contracts/src/artifact.ts`
- Modify: `packages/contracts/src/index.ts`
- Create package manifests/tsconfigs for `packages/auth`, `packages/core`, `packages/documents`, `packages/storage`, `packages/artifacts`
- Modify: `package.json`
- Test: `packages/contracts/test/phase-1-contracts.test.ts`

**Interfaces:**
- Produces `IdSchema`, `OwnerPublicSchema`, `SetupOwnerRequestSchema`, `LoginRequestSchema`, `ProjectSchema`, `CreateProjectRequestSchema`, `NoteDocumentSchema`, `DocumentRevisionSchema`, `UpdateNoteRequestSchema`, `ArtifactSchema`.
- `UpdateNoteRequestSchema` requires `baseRevisionId`; later services use it for optimistic conflict detection.

- [ ] Write failing contract tests for valid/invalid IDs, password length 12..128, project name 1..120, note title 1..200, and required `baseRevisionId`.
- [ ] Run `npm test -w @uw/contracts -- phase-1-contracts.test.ts` and confirm RED because schemas are absent.
- [ ] Implement Zod schemas. Use UUID IDs, ISO datetimes, JSON-safe metadata, and `DocumentKindSchema = z.literal("note")` for Phase 1.
- [ ] Export every schema/type from `packages/contracts/src/index.ts`.
- [ ] Add five domain packages to workspaces with build/typecheck/test scripts matching existing package conventions.
- [ ] Update root build order to: contracts → shared → auth/core/documents/storage/artifacts → database → server → web.
- [ ] Run contract tests, workspace verification, typecheck, and build.
- [ ] Commit: `feat: define phase 1 contracts and package boundaries`.

### Task 2: PostgreSQL Phase 1 schema and explicit migration

**Files:**
- Modify: `packages/database/src/schema.ts`
- Create: `packages/database/src/migrate.ts`
- Create: `packages/database/drizzle/0000_phase1.sql`
- Modify: `packages/database/package.json`
- Test: `packages/database/test/phase-1-migration.integration.test.ts`

**Tables:**
- `owner_accounts(id uuid pk, singleton_key smallint unique check = 1, username text unique, password_algorithm text, password_salt text, password_hash text, password_parameters jsonb, created_at timestamptz)`
- `auth_sessions(id uuid pk, owner_id uuid fk, token_hash text unique, created_at timestamptz, expires_at timestamptz, revoked_at timestamptz null)`
- `projects(id uuid pk, owner_id uuid fk, name text, description text null, schema_version integer default 1, created_at timestamptz, updated_at timestamptz)`
- `documents(id uuid pk, project_id uuid fk, kind text, title text, current_revision_id uuid null, created_at timestamptz, updated_at timestamptz)`
- `document_revisions(id uuid pk, document_id uuid fk, revision_number integer, parent_revision_id uuid null, content jsonb, metadata jsonb, created_at timestamptz, unique(document_id, revision_number))`
- after revision table exists, add `documents.current_revision_id -> document_revisions.id`
- `artifacts(id uuid pk, project_id uuid fk, type text, schema_version integer, mime_type text, checksum_sha256 text, size_bytes bigint, storage_key text unique, metadata jsonb, created_at timestamptz)`
- `action_audit(id uuid pk, actor_id uuid fk, project_id uuid null fk, action text, target_type text, target_id uuid null, trace_id uuid, metadata jsonb, created_at timestamptz)`

- [ ] Write migration integration test that starts from empty PostgreSQL, runs `migrateDatabase(pool)`, and asserts all tables/constraints exist.
- [ ] Verify RED because migration runner/tables do not exist.
- [ ] Define Drizzle schema and deterministic SQL migration. Do not use destructive auto-push.
- [ ] Implement `migrateDatabase(pool: Pool): Promise<void>` via Drizzle migrator.
- [ ] Add `npm run migrate -w @uw/database` command requiring `DATABASE_URL`.
- [ ] Test singleton owner constraint, session token hash uniqueness, document revision uniqueness, and project FK enforcement against real PostgreSQL.
- [ ] Run database integration tests twice to prove migration idempotence.
- [ ] Commit: `feat: add phase 1 postgres schema and migration`.

### Task 3: Built-in owner password and session primitives

**Files:**
- Create: `packages/auth/src/password.ts`
- Create: `packages/auth/src/session.ts`
- Create: `packages/auth/src/repository.ts`
- Create: `packages/auth/src/index.ts`
- Test: `packages/auth/test/password.test.ts`
- Test: `packages/auth/test/session.test.ts`

**Interfaces:**
```ts
export interface PasswordHasher {
  hash(password: string): Promise<StoredPasswordHash>;
  verify(password: string, stored: StoredPasswordHash): Promise<boolean>;
}

export interface SessionToken {
  raw: string;
  digest: string;
}

export function createSessionToken(): SessionToken;
export function digestSessionToken(raw: string): string;
```

Production Argon2id parameters: memory 19 * 1024 KiB, passes 2, parallelism 1, tagLength 32, random 16-byte salt. Parameters are stored with the hash so later upgrades can rehash safely.

- [ ] Write RED tests proving same password gets different salts/hashes, valid verification passes, invalid password fails, and raw session token differs from DB digest.
- [ ] Implement asynchronous Node `crypto.argon2("argon2id", ...)` and `timingSafeEqual` verification.
- [ ] Implement 32-byte random base64url session tokens and SHA-256 hex digests.
- [ ] Ensure error objects never include the plaintext password/token.
- [ ] Run auth tests and typecheck.
- [ ] Commit: `feat: add owner password and session primitives`.

### Task 4: Auth repository, first-run setup, login, logout, and auth middleware

**Files:**
- Create: `packages/database/src/repositories/auth.ts`
- Create: `packages/auth/src/service.ts`
- Create: `apps/server/src/middleware/auth.ts`
- Create: `apps/server/src/routes/setup.ts`
- Create: `apps/server/src/routes/auth.ts`
- Modify: `apps/server/src/config.ts`
- Modify: `apps/server/src/composition.ts` (created here if absent)
- Modify: `apps/server/src/app.ts`
- Test: `apps/server/test/auth.integration.test.ts`

**Interfaces:**
```ts
AuthService.isInitialized(): Promise<boolean>
AuthService.setupOwner(input): Promise<{ owner: OwnerPublic; session: SessionToken }>
AuthService.login(input): Promise<{ owner: OwnerPublic; session: SessionToken }>
AuthService.resolveSession(rawToken: string): Promise<OwnerPublic | null>
AuthService.logout(rawToken: string): Promise<void>
```

Cookie behavior:
- cookie value is raw random session token; DB stores only digest;
- `HttpOnly`, `SameSite=Lax`, `Path=/` always;
- `Secure` when `SESSION_COOKIE_SECURE=true`;
- 7-day TTL by default (`SESSION_TTL_SECONDS=604800`);
- no `Domain` attribute.

Routes:
- `GET /setup/status`
- `POST /setup/owner` (only before initialization)
- `POST /auth/login`
- `GET /auth/session`
- `POST /auth/logout`

- [ ] Write RED integration tests: setup status false; first setup succeeds; second setup returns 409; stored DB password is not plaintext; bad login 401; good login sets HttpOnly cookie; session route returns owner; logout revokes DB session and clears cookie; expired/revoked tokens return 401.
- [ ] Implement PostgreSQL auth repository with singleton insert transaction.
- [ ] Implement AuthService using PasswordHasher and injected Clock/IdGenerator from `@uw/shared`.
- [ ] Add cookie parser helper that reads only the configured session cookie; do not add a broad cookie middleware dependency.
- [ ] Add `requireOwner` middleware attaching trusted owner identity to `res.locals`.
- [ ] Wire routes through composition root and runtime schemas.
- [ ] Run server auth integration tests with PostgreSQL.
- [ ] Commit: `feat: add built-in owner authentication`.

### Task 5: Project service and Action Layer

**Files:**
- Create: `packages/core/src/action.ts`
- Create: `packages/core/src/projects.ts`
- Create: `packages/core/src/index.ts`
- Create: `packages/database/src/repositories/projects.ts`
- Create: `packages/database/src/repositories/audit.ts`
- Test: `packages/core/test/action.test.ts`
- Test: `packages/database/test/projects.integration.test.ts`

**Interfaces:**
```ts
export interface ActionContext {
  actorId: string;
  traceId: string;
  projectId?: string;
}

export async function executeAction<I, O>(spec: {
  name: string;
  input: I;
  context: ActionContext;
  authorize(): Promise<void>;
  run(): Promise<O>;
  audit(result: O): Promise<void>;
}): Promise<O>;
```

Project service:
```ts
create(ownerId, input, traceId): Promise<Project>
list(ownerId): Promise<Project[]>
get(ownerId, projectId): Promise<Project>
update(ownerId, projectId, input, traceId): Promise<Project>
```

- [ ] Write RED Action Layer tests proving `authorize` runs before mutation, denied actions never call `run`, successful actions audit, and failed mutations do not emit success audit rows.
- [ ] Implement minimal Action Layer; do not build a plugin/workflow policy engine yet.
- [ ] Write RED PostgreSQL tests proving an owner can CRUD allowed project fields and another actor ID cannot read/update the project.
- [ ] Implement ProjectRepository and ProjectService; client-provided owner ID is never accepted in create/update request schemas.
- [ ] Ensure create/update actions write `action_audit` with action name, project ID, trace ID, and non-sensitive metadata.
- [ ] Run core/database tests.
- [ ] Commit: `feat: add project service and action boundary`.

### Task 6: Document revisions with optimistic conflict protection

**Files:**
- Create: `packages/documents/src/model.ts`
- Create: `packages/documents/src/repository.ts`
- Create: `packages/documents/src/service.ts`
- Create: `packages/documents/src/index.ts`
- Create: `packages/database/src/repositories/documents.ts`
- Test: `packages/database/test/documents.integration.test.ts`

**Interfaces:**
```ts
createNote(ownerId, projectId, { title, body }, traceId): Promise<NoteDocumentView>
updateNote(ownerId, projectId, documentId, {
  title,
  body,
  baseRevisionId,
}, traceId): Promise<NoteDocumentView>
listNotes(ownerId, projectId): Promise<NoteDocumentSummary[]>
getNote(ownerId, projectId, documentId): Promise<NoteDocumentView>
listRevisions(ownerId, projectId, documentId): Promise<DocumentRevision[]>
```

`NoteDocumentView` includes current revision ID and body. Every update appends a revision; no revision row is updated in place.

- [ ] Write RED tests: create note yields revision 1; update yields revision 2 pointing to revision 1; prior revision content remains unchanged; stale `baseRevisionId` throws typed `RevisionConflictError`; cross-project/cross-owner IDs cannot access the note.
- [ ] Implement transaction: lock document row, compare current revision, insert new revision, update document title/current revision, commit.
- [ ] Map DB conflict to domain `RevisionConflictError { currentRevisionId }`.
- [ ] Ensure audit record is written through Action Layer for create/update note.
- [ ] Run tests twice against a clean migrated PostgreSQL DB.
- [ ] Commit: `feat: add immutable document revisions`.

### Task 7: Local filesystem storage and immutable Artifact service

**Files:**
- Create: `packages/storage/src/backend.ts`
- Create: `packages/storage/src/local-filesystem.ts`
- Create: `packages/storage/src/index.ts`
- Create: `packages/artifacts/src/model.ts`
- Create: `packages/artifacts/src/repository.ts`
- Create: `packages/artifacts/src/service.ts`
- Create: `packages/artifacts/src/index.ts`
- Create: `packages/database/src/repositories/artifacts.ts`
- Test: `packages/storage/test/local-filesystem.test.ts`
- Test: `packages/database/test/artifacts.integration.test.ts`

**Interfaces:**
```ts
export interface StorageBackend {
  put(input: { key: string; bytes: Uint8Array }): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  remove(key: string): Promise<void>;
}

ArtifactService.create(ownerId, projectId, {
  type,
  mimeType,
  bytes,
  metadata,
}, traceId): Promise<Artifact>
```

- [ ] Write RED filesystem tests for atomic write/read, parent directory creation, traversal-resistant opaque keys, and remove.
- [ ] Implement local backend using staging temp file + rename. The backend accepts only normalized opaque storage keys produced by ArtifactService, never original filenames.
- [ ] Write RED artifact tests proving SHA-256/size persisted, content round-trips, metadata immutable, and a DB failure triggers best-effort storage cleanup.
- [ ] Implement ArtifactService with UUID artifact ID and storage key `<projectId>/<artifactId>/<sha256>`.
- [ ] Do not add a public arbitrary-upload endpoint in Phase 1.
- [ ] Run storage/artifact tests.
- [ ] Commit: `feat: add immutable artifact storage core`.

### Task 8: Protected Project, Document, and Artifact HTTP APIs

**Files:**
- Create: `apps/server/src/middleware/validate.ts`
- Create: `apps/server/src/routes/projects.ts`
- Create: `apps/server/src/routes/documents.ts`
- Create: `apps/server/src/routes/artifacts.ts`
- Modify: `apps/server/src/composition.ts`
- Modify: `apps/server/src/app.ts`
- Test: `apps/server/test/data-api.integration.test.ts`

**Routes:**
- `GET /projects`
- `POST /projects`
- `GET /projects/:projectId`
- `PATCH /projects/:projectId`
- `GET /projects/:projectId/documents`
- `POST /projects/:projectId/documents` (Phase 1 note only)
- `GET /projects/:projectId/documents/:documentId`
- `PATCH /projects/:projectId/documents/:documentId`
- `GET /projects/:projectId/documents/:documentId/revisions`
- `GET /projects/:projectId/artifacts`
- `GET /projects/:projectId/artifacts/:artifactId`
- `GET /projects/:projectId/artifacts/:artifactId/content`

- [ ] Write RED API tests requiring authentication on every route.
- [ ] Add Zod body/param validation returning shared JSON error envelopes with request IDs.
- [ ] Map domain not-found to 404, revision conflict to 409 with `currentRevisionId`, validation to 400, authorization concealment to 404 where appropriate.
- [ ] Ensure all POST/PATCH routes call domain services that use Action Layer; routers contain no direct SQL.
- [ ] Artifact content route sets stored MIME type, `Content-Length`, and `Content-Disposition: attachment`; no original filename path handling exists.
- [ ] Run server integration suite.
- [ ] Commit: `feat: expose protected project data APIs`.

### Task 9: First-run, login, project, and note PWA UX

**Files:**
- Create: `apps/web/src/api/client.ts`
- Create: `apps/web/src/auth/AuthGate.tsx`
- Create: `apps/web/src/auth/SetupOwner.tsx`
- Create: `apps/web/src/auth/Login.tsx`
- Create: `apps/web/src/projects/ProjectList.tsx`
- Create: `apps/web/src/projects/ProjectWorkspace.tsx`
- Create: `apps/web/src/documents/NoteEditor.tsx`
- Modify: `apps/web/src/App.tsx`
- Test: `apps/web/test/phase-1-flow.test.tsx`

**UX flow:**
`uninitialized -> create owner -> authenticated project list -> create project -> create note -> edit note -> revision-safe save`.

- [ ] Write RED component tests with mocked fetch for setup, login failure, project creation, note create/edit, and 409 conflict message.
- [ ] Implement API client with `credentials: "include"` and typed parsing through contracts.
- [ ] Implement AuthGate state machine without a new router/state-management dependency.
- [ ] Setup form requires username and 12+ character password; password is never persisted client-side.
- [ ] Project list supports create/select. Project workspace supports notes list/create/select.
- [ ] NoteEditor retains `baseRevisionId`; on 409 it does not overwrite local text and displays a conflict notice with a reload-current action.
- [ ] Keep mobile layout first and touch targets accessible; no graph/workflow UI.
- [ ] Run web tests, typecheck, and production build.
- [ ] Commit: `feat: add phase 1 owner project and note UI`.

### Task 10: Explicit migration deployment and Phase 1 Docker smoke

**Files:**
- Modify: `deploy/docker/compose.yml`
- Modify: `apps/server/Dockerfile`
- Modify: `scripts/smoke-http.mjs`
- Modify: `docs/runbooks/local-development.md`
- Create: `docs/architecture/phase-1.md`

**Deployment invariant:** migrations are explicit and fail loudly. Compose uses a one-shot `migrate` service; `app` starts only after `postgres` is healthy and `migrate` exits successfully.

- [ ] Add `migrate` Compose service using the server image and `npm run migrate -w @uw/database` or compiled migration entrypoint.
- [ ] Add persistent artifact volume mounted at configured `ARTIFACTS_DIR`.
- [ ] Extend smoke script on ephemeral CI stack: check setup uninitialized; create random owner password; retain session cookie; create project; create note; update note using base revision; verify revision count 2; verify stale update returns 409; logout; verify protected route 401.
- [ ] Keep smoke secrets generated at runtime and never print them.
- [ ] Update runbook with `docker compose up`, explicit migration behavior, owner setup, artifact directory, and secure-cookie HTTPS setting.
- [ ] Run Docker Compose smoke locally/CI.
- [ ] Commit: `feat: verify phase 1 deployment flow`.

### Task 11: Final Phase 1 quality gate and documentation alignment

**Files:**
- Modify: `.github/workflows/ci.yml` only if new migration/artifact checks require explicit steps.
- Modify: `README.md`
- Modify: `docs/architecture/phase-1.md`

**Final gate:**

```text
npm ci                                      PASS
npm audit --omit=dev --audit-level=high     PASS
npm run verify:workspaces                   PASS
npm run format:check                        PASS
npm run lint                                PASS
npm run typecheck                           PASS
npm test                                    PASS
npm run build                               PASS
node scripts/verify-pwa.mjs                 PASS
PostgreSQL fresh migration                  PASS
Auth integration                            PASS
Project authorization                       PASS
Document revision/conflict                   PASS
Artifact storage integration                 PASS
Docker Phase 1 vertical smoke               PASS
```

- [ ] Run the entire CI matrix from a clean checkout and fresh PostgreSQL.
- [ ] Confirm no plaintext password or raw session token appears in test logs, audit rows, DB session rows, or error envelopes.
- [ ] Confirm no state-changing router writes directly to Drizzle/repositories outside domain services/Action Layer.
- [ ] Confirm current Phase 1 code contains no WebSocket sync, AI, workflow engine, or arbitrary upload implementation.
- [ ] Update README status to Phase 1 and document the next boundary: Phase 2 local-first/sync.
- [ ] Commit only if final documentation/gate files changed: `docs: close phase 1 project data core`.
- [ ] Open PR `phase-1-project-data-core -> main`, request review, address findings with regression tests, then merge only after PR CI and post-merge `main` CI are green.

---

## Self-Review

### Spec coverage
- Owner auth: Tasks 3–4 and 9.
- Projects: Tasks 5, 8, 9.
- Documents/Revisions: Tasks 6, 8, 9.
- Artifacts/storage abstraction: Task 7 and read APIs in Task 8.
- Action Layer: Task 5; all state-changing APIs use it in Tasks 6–8.
- Runtime schemas: Tasks 1 and 8.
- PostgreSQL-only server storage: Task 2.
- Drizzle behind repositories: Tasks 2, 4–7.
- Secure cookies and no raw secrets: Tasks 3–4, verified in Task 11.
- Mobile-first product path: Task 9.
- Explicit migration/deployment discipline: Task 10.

### Intentional deferrals
Phase 2 owns SQLite WASM/OPFS, durable operation journal, WebSocket sync, device identity, tombstones, and conflict synchronization. Phase 3 owns tools/workflows/provenance. Phase 4 owns AI and universal Send To. Phase 5 owns arbitrary upload hardening, recovery, broader rate limiting, backup/restore drills, and private-release hardening.

### Placeholder scan
No TBD/TODO/"similar to" implementation steps are present.

### Type consistency
`baseRevisionId`, `currentRevisionId`, `traceId`, owner/project/document/artifact UUIDs, and Action Layer names are consistent across contracts, services, API, and UI tasks.
