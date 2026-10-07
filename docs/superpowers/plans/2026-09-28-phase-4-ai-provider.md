# Phase 4 — AI Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add AI provider abstraction, BYO secrets (local + Cloud Vault), AI Tool with structured outputs, Universal Send to, and usage accounting to complete the north-star `HTTP -> JSON -> AI -> Note -> Sync` flow.

**Architecture:** Phase 4 keeps the modular monolith and the Phase 3 rule that AI is a Tool, not a separate subsystem. A new `@uw/providers` package abstracts chat/AI HTTP behind the existing egress policy; `builtin.ai.complete@1.0.0` consumes it through the Tool Registry with pinned versions, typed bindings, preflight permissions, durable execution, receipts, and provenance. Secrets travel only as `secret://scope/name` references and are resolved at the server execution boundary, never persisted in execution rows, receipts, provenance, logs, or sync journals.

**Tech Stack:** Node.js 24 LTS, TypeScript 5.9, Zod 4, Express 5, PostgreSQL 17, Drizzle ORM, React 19/Vite 8 PWA, Vitest 5, Playwright Chromium, npm workspaces, WebCrypto/AES-GCM for Vault encryption.

**Spec:** `docs/superpowers/specs/2026-09-15-universal-workbench-design.md`

> **Revision (2026-09-28):** fixes the `@uw/tools` ↔ `@uw/providers` cycle via a
> new `@uw/egress` leaf plus structural provider injection (no runtime import
> either way); pins the Vault envelope (GCM tag, key version, rekey, recovery);
> hardens the Local Secrets device boundary; makes token accounting crash- and
> retry-safe with explicit billing-uncertainty language; extends the golden E2E
> to a second synced device; and gates the mock provider out of production.

## Global Constraints

- Work only on branch `phase-4-ai-provider`; do not modify or merge `main`.
- Node.js remains `>=24 <25`; CI uses Node `24.21.0`.
- PostgreSQL is the only server database in v0.1.
- Queue implementation is PostgreSQL-backed; do not add Redis.
- Workflows are DAGs internally and linear-first in the v0.1 UI; arbitrary cycles/loops are forbidden.
- No arbitrary shell or user-supplied code execution.
- Workflow definitions pin exact tool versions; AI tool is `builtin.ai.complete@1.0.0`.
- All state-changing HTTP/workflow/secret actions remain behind the existing authentication/authorization and Action Layer boundaries.
- Imported or persisted workflow definitions never auto-run.
- Content may request actions; content cannot grant permissions.
- Raw secrets must not enter logs, operation journals, provenance, receipts, execution inputs/outputs, error envelopes, Docker logs, or analytics.
- Projects/workflows store only references of form `secret://vault/<name>` or `secret://local/<name>`, never raw values.
- Built-in HTTP and AI provider execution accept only HTTP/HTTPS and must pass the outbound egress policy before every request and redirect; LAN/private access stays disabled by default.
- Local-first/sync behavior from Phase 2 must remain intact; AI outputs sync as normal Documents/Artifacts.
- Existing Phase 0–3 permanent CI, Docker, browser-sync, workflow, and secret-leak gates must continue passing.
- AI is mocked by deterministic providers in the normal suite; real-provider checks are opt-in and never run in CI by default.
- Dependency direction is acyclic: `@uw/egress` is a leaf (Node stdlib only);
  `@uw/tools` and `@uw/providers` both depend on `@uw/egress` and never on
  each other at runtime — `packages/tools/**` must not import
  `@uw/providers`, `packages/providers/**` must not import `@uw/tools`
  (enforced by a grep gate in Task 11). The AI tool receives its provider map
  by structural injection at server composition time.
- The `mock` AI provider is test-only: it registers only when
  `NODE_ENV=test` plus an explicit opt-in (`WORKBENCH_AI_MOCK=1` or one of the
  existing fixture flags `WORKBENCH_E2E_FIXTURE` /
  `WORKBENCH_DOCKER_SMOKE_FIXTURE`). Production composition never registers
  it; without real-provider env config the AI tool fails closed with
  `AI_PROVIDER_NOT_CONFIGURED`.

## Review Focus

1. **BYO key in AI error/receipt/log:** an AI failure with a valid key must return a structured error and receipt with zero secret characters; a reviewer pasting the receipt into search must find no key substring — Task 6/8 own this.
2. **Prompt-injected permission escalation:** AI output text claiming `{"grant":"network"}` or `{"role":"owner"}` must not widen the next step's permissions; the next node still fails preflight without a server grant — Task 7 owns this.
3. **Structured-output schema mismatch:** an AI result that is valid JSON but violates the node's `jsonSchema` must fail the step with a structured `AI_SCHEMA_MISMATCH`, not silently pass a string through — Task 6 owns this.
4. **Retried AI call double-billing usage:** a reclaimed queue lease reprocessing a completed AI step must reuse the stored step and must not double-count prompt/completion tokens — Task 7 owns this.
5. **Provider endpoint SSRF bypass:** configuring `baseUrl: "http://169.254.169.254/"` or a public URL that redirects to a private target must be rejected before any request bytes, same as the HTTP tool — Task 5 owns this.

---

### Task 1: Phase 4 contracts — `ai_response`, AI config, structured outputs, extended usage

**Files:**

- Modify: `packages/contracts/src/context.ts`
- Modify: `packages/contracts/src/tool.ts`
- Create: `packages/contracts/src/ai.ts`
- Create: `packages/contracts/src/secrets.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/test/phase-4-contracts.test.ts`

**Interfaces:**

- Consumes: `ContextEnvelope`, `ToolDescriptor` from Task 1 Phase 3 (unchanged shapes).
- Produces:

```ts
type ContextType =
  | "text"
  | "markdown"
  | "json"
  | "api_response"
  | "artifact_ref"
  | "ai_response";

interface AiResponsePayload {
  text: string;
  model: string;
  structured?: unknown;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  usageSource: "provider" | "estimated";
  providerRequestId?: string;
}

interface AiToolConfig {
  providerId: string;
  model: string;
  prompt: string;
  systemPrompt?: string;
  secretRef: string; // must match secret://(vault|local)/[a-z0-9._-]+
  responseFormat?:
    { kind: "text" } | { kind: "json"; jsonSchema: Record<string, unknown> };
  maxOutputTokens?: number;
  timeoutMs?: number;
}

interface ExecutionUsageV2 {
  attempts: number;
  inputBytes: number;
  outputBytes: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}
```

- [ ] **Step 1: Write RED contract tests** proving `ai_response` envelope parses, old five types still parse (backward compat), `AiToolConfig` accepts text + json-schema variants and rejects `secretRef` without `secret://` prefix, rejects `json` format without `jsonSchema`, and `ExecutionUsageV2` requires non-negative integer token fields while a legacy `{attempts,inputBytes,outputBytes}` object migrates with zero tokens.
- [ ] **Step 2: Run RED test:** `npm test -w @uw/contracts -- phase-4-contracts.test.ts`. Expected failure: `ai`/`secrets` exports do not exist.
- [ ] **Step 3: Implement `ai.ts` (Zod schemas + inferred types) and `secrets.ts` (`SecretRefSchema`, `parseSecretRef`, `isSecretLikeKey`)**; extend `ContextTypeSchema` with `ai_response` without renaming existing values.
- [ ] **Step 4: Run GREEN:** `npm test -w @uw/contracts`, then `npm run typecheck -w @uw/contracts`.
- [ ] **Step 5: Commit:** `feat: add phase 4 ai and secret contracts`.

### Task 2: Secret reference core + redaction helpers

**Files:**

- Create: `packages/shared/src/secrets.ts` (or `packages/tools/src/secrets/redaction.ts` if `shared` owns no secret logic — prefer `shared` so server, tools, and execution share one import)
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/secrets.test.ts`

**Interfaces:**

- Consumes: `SecretRefSchema` from Task 1.
- Produces:

```ts
type SecretScope = "vault" | "local";
interface ParsedSecretRef {
  scope: SecretScope;
  name: string;
}
function parseSecretRef(ref: unknown): ParsedSecretRef;
function isSecretLikeKey(key: string): boolean;
function redactSecrets(value: unknown): unknown;
```

`isSecretLikeKey` matches `/(api[_-]?key|secret|token|password|authorization|bearer|session)/i`. `redactSecrets` deep-clones JSON values and replaces values under secret-like keys with `"[REDACTED]"`.

- [ ] **Step 1: Write RED tests** for `secret://vault/openai` → `{vault, openai}`, `secret://local/x` scope, rejection of `https://`, empty name, uppercase scope, path traversal `../`, and `redactSecrets` replacing `apiKey`/`Authorization` values while leaving `model`/`prompt` intact.
- [ ] **Step 2: Run RED:** `npm test -w @uw/shared -- secrets.test.ts`. Expected failure: module missing.
- [ ] **Step 3: Implement pure functions**; no filesystem, network, or crypto here.
- [ ] **Step 4: Run GREEN** shared tests + full `npm test -w @uw/shared`.
- [ ] **Step 5: Commit:** `feat: add secret reference and redaction core`.

### Task 3: Cloud Vault — encrypted server store + APIs

**Files:**

- Modify: `packages/database/src/schema.ts`
- Create: `packages/database/drizzle/0006_phase4_vault.sql`
- Create: `packages/database/src/repositories/vault.ts`
- Modify: `packages/database/src/index.ts`
- Create: `apps/server/src/routes/vault.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/composition.ts`
- Test: `packages/database/test/vault.integration.test.ts`
- Test: `apps/server/test/vault-api.integration.test.ts`

**Interfaces:**

- Consumes: `parseSecretRef`, `redactSecrets` from Task 2.
- Produces:

```ts
interface VaultStore {
  put(ownerId: string, name: string, plaintext: string): Promise<void>;
  get(ownerId: string, name: string): Promise<string | null>;
  remove(ownerId: string, name: string): Promise<void>;
  list(ownerId: string): Promise<string[]>;
}
```

`put` encrypts inside the repository; `get` decrypts and returns plaintext to
the server caller only (never logged). The repository owns the full envelope —
callers never handle IV/tag bytes. Row shape
`(owner_id, name, key_version INT NOT NULL, iv BYTEA(12) NOT NULL, ciphertext BYTEA NOT NULL, auth_tag BYTEA(16) NOT NULL)`
with `UNIQUE(owner_id, name)`.

Encryption envelope (AES-256-GCM, one row = one envelope):

- Keyring from env `VAULT_MASTER_KEYS` formatted
  `"<version>:<base64-32B>,<version>:<base64-32B>,..."` (versions are positive
  ints, newest = highest). Legacy single-key `VAULT_MASTER_KEY` (base64 32
  bytes) is accepted and treated as version `1`; if both are set,
  `VAULT_MASTER_KEYS` wins. Missing/empty keyring → all vault routes return
  503 without stack or key-material leak.
- Per-secret random 12-byte IV from `crypto.getRandomValues`; 16-byte GCM
  authentication tag stored in its own `auth_tag` column (never concatenated
  ambiguously — encrypt produces `ciphertext || tag`, repository splits on
  write and rejoins on read with fixed 16-byte split).
- AAD binds the row: `aad = "vault:v1\0" + ownerId + "\0" + name`, so a
  ciphertext copied to another owner/name fails authentication instead of
  decrypting.
- Tag/AAD verification failure surfaces as a generic concealment error
  (`404` on read-paths to match cross-owner concealment, `500` without detail
  on decrypt-during-run) — never `ERR_OSSL_EVP_*` text, never which byte
  failed. No oracle: comparison outcomes are not timing-signalled beyond the
  single boolean GCM verify.
- `list` returns names only, ordered; `PUT` value limit 1 byte–8 KiB
  (after UTF-8 encode); name rule `^[a-z0-9][a-z0-9._-]{0,127}$`.

Key rotation (online, no plaintext export):

- Operator appends `<newVersion>:<base64>` to `VAULT_MASTER_KEYS` (newest
  last-wins by numeric version) and redeploys. New `put` calls encrypt under
  the newest version; `get` selects the key by the row's `key_version` and
  decrypts — old rows keep working.
- `npm run vault:rekey -- --dry-run` reports `(totalRows, perVersionCounts)`
  without touching data. Without `--dry-run` it re-encrypts every row whose
  `key_version != newest` inside one transaction per row
  (`SELECT ... FOR UPDATE`, decrypt-with-old, encrypt-with-new, update
  `key_version/iv/ciphertext/auth_tag`), logging only
  `(ownerless row count, version from → to)` totals. Re-running is a no-op.
- Dropping the old `<version>:` entry is allowed only after `vault:rekey`
  reports zero rows on that version; otherwise reads on those rows fail closed
  (503 on write-paths, concealment error on reads) until the key is restored.

Recovery procedure (documented in runbook, Task 11):

- The keyring is backed up in the deployment secret manager before first use;
  there is deliberately **no** plaintext backup and no recovery key — losing
  every copy of the keyring means vault contents are cryptographically
  unrecoverable (this is stated verbatim in the runbook warning).
- Recovery steps on loss: (1) provision a fresh keyring version, (2) `DELETE`
  all vault rows (they are unusable), (3) rotate the underlying third-party
  provider keys (assume compromise-window hygiene), (4) re-enter values via
  `PUT /api/vault/:name`. A `GET /api/vault/health` endpoint reports only
  `{ configured: boolean, newestVersion: number | null, rowCount: number }`
  for operators — never key bytes.

Routes (owner-scoped, session auth, no owner ID from JSON):

- `GET /api/vault` → `{ secrets: string[] }` (names only)
- `PUT /api/vault/:name` body `{ value: string }` (1–8 KiB limit) → `{ name }`
- `DELETE /api/vault/:name` → `{ deleted: true }`

- [ ] **Step 1: Write RED migration tests** for owner+name uniqueness, owner isolation, `key_version`/`iv`/`ciphertext`/`auth_tag` not-null constraints, and IV uniqueness across two puts of the same value (ciphertexts differ).
- [ ] **Step 2: Write RED crypto tests** (repository-level, no HTTP): round-trip put→get; tampered `auth_tag` byte → decrypt fails with concealment error and zero plaintext bytes in the error; row copied to another owner/name → AAD bind fails; old-version row decrypts after a new key is appended (encrypt-with-v1, read-with-v1+v2 keyring).
- [ ] **Step 3: Write RED API tests** for put→list→delete round-trip, cross-owner 404 concealment, oversize value → 413, missing keyring → 503 without stack leak, and log-scan asserting the raw value appears nowhere in error bodies.
- [ ] **Step 4: Run RED** against fresh PostgreSQL. Expected failure: table/routes missing.
- [ ] **Step 5: Implement migration + repository + rekey script + routes** through `requireOwner` middleware; `PUT` validates name `^[a-z0-9][a-z0-9._-]{0,127}$`.
- [ ] **Step 6: Write RED rekey tests**: seed rows on v1, append v2, dry-run reports counts without modifying rows, real run moves all rows to v2, second run is a no-op, removing v1 afterwards still reads.
- [ ] **Step 7: Run GREEN** database + server tests and `npm run typecheck -w @uw/database -w @uw/server`.
- [ ] **Step 8: Commit:** `feat: add encrypted cloud vault store and APIs`.

### Task 4: Local Secrets (BYO, device-only) + web management UI

**Files:**

- Create: `apps/web/src/secrets/local-secrets.ts`
- Create: `apps/web/src/secrets/SecretsSettings.tsx`
- Modify: `apps/web/src/App.tsx` (settings route/tab)
- Test: `apps/web/test/local-secrets.test.ts`

**Interfaces:**

- Consumes: `parseSecretRef` (Task 2) for validation only.
- Produces:

```ts
interface LocalSecretStore {
  list(): Promise<string[]>;
  put(name: string, value: string): Promise<void>;
  remove(name: string): Promise<void>;
  get(name: string): Promise<string | null>;
}
```

Storage: IndexedDB (never OPFS-sync journal, never server sync, never export bundle). UI lists names only, masks values, confirms delete, warns that local secrets stay on this device.

Device-vs-server boundary (fail-closed both sides):

- Local values never leave the device: the store has no network call; no
  value is placed in workflow definitions, enqueue payloads, sync operations,
  export bundles, clipboard, or error reports. Workflow definitions persist
  only the `secret://local/<name>` reference string (name only, same character
  rule as vault names). A repository grep gate (`secret://local` must appear
  only in web + `resolve.ts` throw-path + tests) pins this.
- The AI step editor allows picking `secret://local/<name>` but shows an
  inline warning — "stays on this device; server runs will fail" — and the Run
  screen preflight flags any `secret://local/*` reference as
  `server-unresolvable` before enqueue.
- Server execution always fails closed: `resolveSecretResource` throws
  `LOCAL_SECRET_NOT_AVAILABLE_ON_SERVER` at step runtime without retry
  (non-retryable error code, see Task 7), the step receipt carries the code
  with zero secret bytes, and the value is never requested from the client.
- Tests: fake-IndexedDB round-trip; `list()` output scan proving the value
  absent; sync-journal/export-bundle scan proving no `secret://local` value
  (references allowed, values forbidden); server integration asserting a
  `secret://local/k` run fails with the typed code and no retry storm.

- [ ] **Step 1: Write RED component/store tests** for put→list(names-only)→get→remove, invalid name rejection, value never appearing in `list()` output, persistence across reload via fake IndexedDB, and value-absence scans over a synthetic sync journal + export bundle.
- [ ] **Step 2: Run RED:** `npm test -w @uw/web -- local-secrets.test.ts`. Expected failure: module missing.
- [ ] **Step 3: Implement store + settings screen** with existing AuthGate/project shell styles; no new global state manager. Include the server-run warning + preflight flag above.
- [ ] **Step 4: Run GREEN** web tests, typecheck, production build.
- [ ] **Step 5: Commit:** `feat: add device-only local secret store UI`.

### Task 5: `@uw/egress` extraction + `@uw/providers` — provider abstraction + deterministic mock + HTTP provider

**Dependency design (acyclic — no `@uw/tools` ↔ `@uw/providers` edge):**

- New leaf package `@uw/egress` owns the egress policy. Move
  `packages/tools/src/network/egress-policy.ts` → `packages/egress/src/index.ts`
  verbatim (same exports: `createEgressPolicy`, `EgressPolicyError`,
  `isPublicAddress`, types `EgressPolicy`, `DnsResolver`). `@uw/egress` has
  zero workspace dependencies (Node stdlib only).
- `packages/tools/src/index.ts` keeps re-exporting the egress symbols from
  `@uw/egress` so Phase 3 imports keep working; HTTP tool internals import
  from `@uw/egress`.
- `@uw/providers` imports `EgressPolicy`/`createEgressPolicy` only from
  `@uw/egress` — never from `@uw/tools`.
- The `AiProvider` interface lives in `@uw/providers`; `@uw/tools` defines a
  structural `AiProviderPort` copy and the AI executor depends only on the
  port (duck typing, no `import ... from "@uw/providers"`). Server
  composition holds a compile-time assignability assertion
  (`const _check: AiProviderPort = httpProvider`). Resulting graph:
  `egress ← providers`, `egress ← tools`, `providers + tools ← server`.
  A Task 11 grep gate forbids cross-imports in both directions.

**Files:**

- Create: `packages/egress/package.json` (+ `tsconfig.json`, `src/index.ts` — moved egress policy)
- Modify: `packages/tools/src/network/http-tool.ts` (import from `@uw/egress`)
- Modify: `packages/tools/src/index.ts` (re-export from `@uw/egress`)
- Modify: `packages/tools/package.json` (add `@uw/egress` dep)
- Create: `packages/providers/package.json`
- Create: `packages/providers/tsconfig.json`
- Create: `packages/providers/src/index.ts`
- Create: `packages/providers/src/types.ts`
- Create: `packages/providers/src/mock.ts`
- Create: `packages/providers/src/http-provider.ts`
- Test: `packages/providers/test/providers.test.ts`
- Test: `packages/egress/test/egress.test.ts` (moved from tools egress tests)
- Modify: `scripts/verify-workspaces.mjs` (add `@uw/egress`, `@uw/providers`)
- Modify: `package.json` (build order: `@uw/egress` before `@uw/tools` and `@uw/providers`; no ordering between tools and providers — no edge either way)

**Interfaces:**

- Consumes: `AiToolConfig` (Task 1), `EgressPolicy` from `@uw/egress`, secret value passed in as plain string at call time (never stored).
- Produces:

```ts
interface ProviderRequest {
  model: string;
  prompt: string;
  systemPrompt?: string;
  responseFormat: AiToolConfig["responseFormat"];
  maxOutputTokens: number;
  timeoutMs: number;
  secretValue: string;
  signal: AbortSignal;
  idempotencyKey?: string; // forwarded as provider idempotency header when set
}

interface ProviderResult {
  text: string;
  model: string;
  structured?: unknown;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  usageSource: "provider" | "estimated";
  providerRequestId?: string;
}

interface AiProvider {
  readonly id: string;
  complete(req: ProviderRequest): Promise<ProviderResult>;
}
```

`mock` provider id `mock`: deterministic `text: "mock:${model}:${prompt.slice(0,32)}"`, token counts from byte/4 heuristic marked `usageSource: "estimated"`, honors `json` format by returning `{"echo": prompt}`. HTTP provider: OpenAI-compatible `POST {baseUrl}/chat/completions`, bearer from `secretValue`, `idempotencyKey` forwarded as `Idempotency-Key` header when present, manual redirect handling with `EgressPolicy.assertAllowed` per hop, `Authorization` dropped on redirect, timeout via AbortController, 256 KiB response cap, structured errors without secret bytes. Provider-reported token usage is kept verbatim with `usageSource: "provider"`; when the provider omits usage, the byte/4 estimate applies with `usageSource: "estimated"` (Task 7 treats both as observed-use, see billing note).

Mock availability guard: `mock.ts` exports `createMockProvider()` plus
`isMockAllowed()` which returns true only when `NODE_ENV === "test"` AND
(`WORKBENCH_AI_MOCK === "1"` or `WORKBENCH_E2E_FIXTURE === "1"` or
`WORKBENCH_DOCKER_SMOKE_FIXTURE === "1"`). `createMockProvider()` throws
`MOCK_NOT_ALLOWED` otherwise. Composition (Task 8) calls it only behind the
same check, so a production deploy without the explicit flag can never serve
`mock` even if client config requests `providerId: "mock"` (unknown-provider
error path).

- [ ] **Step 1: Extract `@uw/egress`** — move egress-policy source + tests, wire package manifest/tsconfig, keep tools re-export, run tools + egress tests GREEN before touching providers.
- [ ] **Step 2: Write RED tests** for mock determinism + token math + `usageSource: "estimated"`, mock `MOCK_NOT_ALLOWED` outside the flag matrix (4 cases: prod env, test env without flag, test+flag, smoke fixture), HTTP success path with injected fetch/DNS doubles (no internet), `baseUrl http://169.254.169.254/` rejection, public→private redirect rejection, timeout abort, oversize response error, error-body scan proving secret value absent, and `Idempotency-Key` forwarding when `idempotencyKey` is set.
- [ ] **Step 3: Run RED:** `npm test -w @uw/providers`. Expected failure: package missing.
- [ ] **Step 4: Implement types/mock/HTTP provider** importing egress only from `@uw/egress`; no registry/DB/React/`@uw/tools` deps.
- [ ] **Step 5: Extend workspace verification + root build order.**
- [ ] **Step 6: Run GREEN** egress + providers + tools tests, `npm run verify:workspaces`, full suite.
- [ ] **Step 7: Commit:** `feat: add egress leaf and ai provider abstraction`.

### Task 6: AI Tool executor — `builtin.ai.complete@1.0.0` with structured outputs

**Files:**

- Create: `packages/tools/src/builtin/ai.ts`
- Modify: `packages/tools/src/index.ts`
- Test: `packages/tools/test/ai-tool.test.ts`

**Interfaces:**

- Consumes: `AiProviderPort` (structural copy of Task 5 `AiProvider` — no
  runtime import from `@uw/providers`), `AiToolConfig` + `ContextType
ai_response` (Task 1), `redactSecrets` (Task 2).
- Produces: `createAiTool(deps: { providers: Map<string, AiProviderPort>; resolveSecret: (ref: string) => Promise<string> }): ToolExecutor` with descriptor:

```ts
{
  id: "builtin.ai.complete", version: "1.0.0",
  accepts: ["text", "markdown", "json"],
  produces: ["ai_response"],
  permissions: ["ai"],
  capabilities: ["structured-output"],
  executionMode: "server", idempotency: "keyed",
}
```

Behavior: input payload becomes prompt context (stringified if JSON); config `prompt` + input combined; `resolveSecret` resolves `secretRef` at run time; the provider map is injected (server composition passes real `AiProvider` instances — structural typing, no import); the node's `idempotencyKey` (when present) is forwarded as `ProviderRequest.idempotencyKey` for provider-side dedup; provider `usage` + `usageSource` + `providerRequestId` are copied verbatim into the `ai_response` envelope; `json` format validates provider `structured`/parsed `text` against `jsonSchema` (fail `AI_SCHEMA_MISMATCH`); output envelope type `ai_response` with provenance set by runtime; `usage: {inputBytes, outputBytes}` preserved for budget compat; config validation rejects unknown provider, empty model, `secretRef` malformed, `maxOutputTokens` out of 1–128000. Requesting `providerId: "mock"` when no mock instance was injected fails as unknown-provider (fail-closed; see Tasks 5/8).

- [ ] **Step 1: Write RED tests** for text→ai_response happy path (mock-shaped port double, not the real mock package), markdown/json inputs, json-schema pass/fail, missing secret → typed error without value, secret-like config never echoed in error, `idempotencyKey` forwarded to the port double, `usageSource`/`providerRequestId` passthrough, unknown `providerId: "mock"` → typed error when the map lacks it, idempotency descriptor === `keyed`.
- [ ] **Step 2: Run RED:** `npm test -w @uw/tools -- ai-tool.test.ts`. Expected failure: `createAiTool` missing.
- [ ] **Step 3: Implement executor** with runtime schemas at input/config boundaries; define `AiProviderPort` in `packages/tools/src/builtin/ai.ts` (same shape as `AiProvider`, no cross-package import); Review Focus #3 test lives here.
- [ ] **Step 4: Run GREEN** tools tests + full suite.
- [ ] **Step 5: Commit:** `feat: add ai complete tool with structured outputs`.

### Task 7: Execution accounting — tokens, budgets, receipts, secret-safe persistence

**Files:**

- Modify: `packages/execution/src/budget.ts`
- Modify: `packages/execution/src/engine.ts`
- Modify: `packages/execution/src/receipt.ts`
- Modify: `packages/execution/src/model.ts`
- Test: `packages/execution/test/usage-accounting.test.ts`
- Test: `packages/execution/test/receipt.test.ts` (extend)

**Interfaces:**

- Consumes: `ExecutionUsageV2`, `createAiTool` output envelopes, `redactSecrets`.
- Produces: engine aggregates `promptTokens/completionTokens/totalTokens` from each `ai_response` output payload into step + execution `usage`; `requireBudget` gains optional `maxTotalTokens` (default 200000); receipt `usage` carries token fields; step persistence stores `redactSecrets(inputContext)`-safe config snapshots; reclaimed leases reuse completed steps without re-adding tokens.

Crash / retry / billing-uncertainty design (authoritative rules):

- **Single source of truth is persisted steps, never memory.** `existingUsage`
  is extended to sum token fields from `completed` steps' `ai_response`
  payloads and is recomputed from `store.load()` on every `process()` entry
  (including lease-reclaim re-entry). In-memory `usage` accumulators are a
  cache only; any divergence resolves toward the stored steps.
- **Exactly-once local counting, at-least-once provider billing.** The crash
  window between "provider billed the call" and "`finishStep(completed)` commit"
  is unavoidable: a crash there means the provider charged for an attempt the
  ledger never records. On reclaim, the engine sees the step as `running`
  (never `completed`), marks it `interrupted`, and retries with the same
  `idempotencyKey` (AI descriptor is `keyed`, so `retryClass` returns `keyed`
  and `canRetry` permits one continuation). The provider may bill twice while
  local usage counts the single surviving completion once. Non-retryable codes
  (`LOCAL_SECRET_NOT_AVAILABLE_ON_SERVER`, `AI_SCHEMA_MISMATCH`,
  `BUDGET_*`, `INVALID_*`, `PERMISSION_DENIED`, `CANCELLED`) never retry, so
  they can never double-bill.
- **Completed steps are never recounted.** Reprocessing skips `completed`
  steps by `(nodeId, attempt)` identity and reuses `outputContexts` — token
  totals come from thestored payloads, so a reclaimed lease reprocessing a
  finished AI step adds 0 tokens (Review Focus #4). A second `completed`
  record for the same `(nodeId, attempt)` is rejected by the store
  (`UNIQUE(execution_id, node_id, attempt)` — new constraint, migration
  included) so concurrent workers cannot double-insert.
- **Uncertain outcomes stay visible.** `interrupted` AI attempts contribute 0
  tokens to `usage` but remain in `steps[]` with `UNCERTAIN_OUTCOME` lineage,
  so receipts distinguish "counted tokens" from "possibly billed attempts".
  Receipt `usage` counts completed-step tokens only; the runbook states
  verbatim: receipt totals are _observed usage for budgets and display, not
  the provider invoice_ — the invoice can be higher after crashes/retries.
- **Provider usage is opaque data.** The engine copies `usage` /
  `usageSource` / `providerRequestId` from the envelope without
  reinterpretation; `estimated` rows are display-flagged where surfaced
  (ExecutionStatus shows `~` prefix). `maxTotalTokens` is checked pre-step
  (before scheduling the next AI node) and post-step (after adding its
  usage); overflow fails structured `BUDGET_EXCEEDED` before enqueueing
  further work.
- **Idempotency-key stability.** The AI node's `idempotencyKey`, when set, is
  stable across retries of the same logical step (derived from
  `executionId + nodeId`, not per-attempt random) so provider-side dedup can
  actually match; worker-generated keys are persisted on the step row at
  `startStep` and reused, never regenerated per attempt.

- [ ] **Step 1: Write RED tests** for two-step `text -> AI -> text` token aggregation, budget overflow → structured `BUDGET_EXCEEDED` before scheduling the next step, receipt containing token totals + tool versions but no prompt-secret substring, reclaimed-lease idempotency (tokens counted once), and Review Focus #2 (AI output claiming permissions does not grant them — engine re-checks `permissions` set per step).
- [ ] **Step 2: Write RED crash/retry tests**: (a) crash simulated between provider completion and `finishStep` (port double returns usage, then `finishStep` throws once) → reprocess counts tokens exactly once while the port double records two provider calls (documents at-least-once billing); (b) reclaim with a `running` AI step → step marked `interrupted`, retry reuses the same `idempotencyKey`; (c) duplicate `(execution_id, node_id, attempt)` completed insert → store rejects; (d) `existingUsage` recomputed from a fresh `load()` after external step insert (no in-memory carry); (e) `usageSource: "estimated"` envelope aggregates identically but is flagged; (f) `LOCAL_SECRET_NOT_AVAILABLE_ON_SERVER` does not retry.
- [ ] **Step 3: Run RED:** `npm test -w @uw/execution -- usage-accounting.test.ts`. Expected failure: token fields missing.
- [ ] **Step 4: Implement budget/engine/receipt/store-migration changes** keeping legacy `{attempts,inputBytes,outputBytes}` readable (default tokens to 0).
- [ ] **Step 5: Run GREEN** execution tests + PostgreSQL integration + full suite.
- [ ] **Step 6: Commit:** `feat: add ai usage accounting to execution engine`.

### Task 8: Server wiring — registry, permissions, vault resolution, Send-to APIs

**Files:**

- Modify: `apps/server/src/composition.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/routes/tools.ts` (no change except registry content — verify)
- Modify: `apps/server/src/routes/artifacts.ts` (extend `from-execution` to accept `ai_response` outputs, keep 512 KiB cap)
- Create: `apps/server/src/routes/send-to.ts` (or extend artifacts + documents routes — prefer one new router)
- Create: `apps/server/src/secrets/resolve.ts`
- Test: `apps/server/test/ai-workflow-api.integration.test.ts`

**Interfaces:**

- Consumes: `VaultStore` (Task 3, plaintext-in/plaintext-out envelope owner),
  `AiProvider` map (Task 5), `createAiTool` (Task 6), engine with token usage
  (Task 7), `EgressPolicy` from `@uw/egress` (never from `@uw/tools` inside
  provider paths).
- Produces: `resolveSecretResource(ref, ownerId)` — `vault:` reads via VaultStore + decrypts, `local:` throws `LOCAL_SECRET_NOT_AVAILABLE_ON_SERVER` (local keys never leave the device, so server workflows must use `secret://vault/*`; non-retryable, no retry storm); registry includes the mock AI tool only behind the Task 5 `isMockAllowed()` gate (production never registers it — requesting `providerId: "mock"` in prod fails as unknown provider) and the HTTP AI tool only when real-provider env (`AI_PROVIDER_BASE_URL` + credential ref) is configured, otherwise AI runs fail closed with `AI_PROVIDER_NOT_CONFIGURED`; `workflowPermissions` default stays `[]` (tests grant `["network","ai"]` explicitly); new route `POST /api/projects/:projectId/documents/from-execution` saves a completed `ai_response`/`text`/`markdown` output as a Document via `documentService` (server-read execution record, never client bytes); compile-time assertion that each injected `AiProvider` satisfies the tools-side `AiProviderPort`.

- [ ] **Step 1: Write RED API tests** for catalog containing `builtin.ai.complete@1.0.0`, run with missing `ai` permission → 403 without enqueue, run with `secret://local/k` on server → structured `LOCAL_SECRET_NOT_AVAILABLE_ON_SERVER` without secret bytes and exactly one attempt (no retry), production composition (flags off) → catalog has no `mock` provider and `providerId: "mock"` fails closed, unconfigured production → `AI_PROVIDER_NOT_CONFIGURED`, `from-execution` with `ai_response` → Artifact, `documents/from-execution` with `ai_response` → Document, cross-owner execution concealment.
- [ ] **Step 2: Run RED.** Expected failure: AI tool/routes missing.
- [ ] **Step 3: Implement resolver + registry wiring + routes** through trusted owner middleware; every error path passes through `redactSecrets`.
- [ ] **Step 4: Run GREEN** server/database tests + full suite.
- [ ] **Step 5: Commit:** `feat: wire ai tool and send-to APIs on server`.

### Task 9: Universal Send to + AI workflow UI

**Files:**

- Modify: `packages/context/src/compatibility.ts` (verify `ai_response` flows — no logic change expected beyond new type)
- Create: `apps/web/src/send-to/send-to.ts`
- Create: `apps/web/src/send-to/SendToMenu.tsx`
- Modify: `apps/web/src/tools/tool-catalog.ts` (add `initialConfig` for `builtin.ai.complete`, include `ai_response` in downstream compat)
- Modify: `apps/web/src/workflows/WorkflowEditor.tsx`
- Modify: `apps/web/src/workflows/WorkflowStepEditor.tsx`
- Modify: `apps/web/src/executions/RunWorkflow.tsx`
- Modify: `apps/web/src/executions/ExecutionStatus.tsx`
- Modify: `apps/web/src/api/client.ts`
- Modify: `apps/web/src/projects/ProjectWorkspace.tsx`
- Test: `apps/web/test/send-to.test.tsx`
- Test: `apps/web/e2e/ai-send-to.spec.ts`

**UX:**

- Every Artifact / execution output / note shows **Send to…** generated from Context Bus compatibility + granted permissions (never hard-coded per screen).
- AI step editor exposes provider, model, `secretRef` (vault name picker + local-name hint), response format (text/JSON + schema textarea with validation), max tokens.
- Run screen preflight shows required `ai` permission + model + token budget before enqueue; execution view shows per-step token usage + total.
- AI output offers **Save as Note** (via `documents/from-execution`) and **Save as Artifact** (via existing `from-execution`).

- [ ] **Step 1: Write RED component tests** for Send-to menu listing AI/Note/Artifact candidates for `ai_response`, excluding AI tool without `ai` grant, AI config form validation (bad `secretRef`, JSON schema syntax error), `secret://local/*` selection showing the device-only warning + preflight `server-unresolvable` flag, usage display after run (including `~` estimated marker), save-as-note flow.
- [ ] **Step 2: Write RED Playwright flow** (`apps/web/e2e/ai-send-to.spec.ts`, serial, deterministic mock only): device A creates project `AI E2E <runId>`, builds `HTTP(fixture) -> JSON extract -> AI(mock) -> Note` via the editor, grants `["network","ai"]` at Run preflight, runs to completion, asserts per-step + total token usage visible, clicks **Save as Note** (via `documents/from-execution`), waits for sync status `Synced`; device B (second browser context, same login — reuse the `sync-two-device.spec.ts` helper pattern: `newContext`, `loginOrSetup`, reload, `expect.poll`) opens the same project and asserts the saved Note is visible with the deterministic mock text `mock:<model>:<first-32-chars>`; then device B saves the same output as Artifact and asserts the artifact row appears. No real provider env is read in this spec.
- [ ] **Step 3: Run RED** component/browser tests; failure must be missing Phase 4 UI/API behavior.
- [ ] **Step 4: Implement client + components** reusing AuthGate/project shell; no new state manager or graph library; mobile-first list patterns.
- [ ] **Step 5: Run GREEN** component tests, typecheck, production build, Playwright flow (both devices).
- [ ] **Step 6: Commit:** `feat: add universal send-to and ai workflow ui`.

### Task 10: Golden north-star, Docker smoke, secret-canary hardening

**Files:**

- Create: `packages/execution/test/golden-ai.integration.test.ts`
- Modify: `scripts/smoke-http.mjs`
- Modify: `scripts/verify-no-secrets.mjs` (add AI-key canary + `Authorization: Bearer` + `secret://` value patterns)
- Modify: `deploy/docker/compose.yml` (document `VAULT_MASTER_KEYS` keyring wiring; no real keys committed)
- Modify: `.circleci/config.yml`
- Test: gate scripts only (no new unit files beyond golden test)

**Golden workflows added in Phase 4:**

1. `HTTP -> JSON extract -> AI(mock) -> Note` (north-star, text output).
2. `JSON -> AI(mock, json schema) -> Artifact` (structured outputs + usage assertions).
3. `AI with bad secretRef -> structured Error` (no retry storm, no leak).

Smoke: with `WORKBENCH_DOCKER_SMOKE_FIXTURE=1` + `VAULT_MASTER_KEYS` test keyring + `SMOKE_SECRET_CANARY`, create owner/project, `PUT /api/vault/e2e-ai` with canary value, run HTTP→JSON→AI workflow, assert receipt token totals + provenance length ≥ 3, save AI output as Note + Artifact, then read the Note back through a fresh login session (second-device equivalent: new session token, `GET` project documents + sync pull) and assert the mock text matches; verify canary absent from `docker logs` and from receipt/step API bodies. Assert the mock provider is registered in this fixture mode and would be absent with flags off (unit-covered in Task 5, smoke asserts the positive leg).

- [ ] **Step 1: Write RED golden integration tests** with mock provider; verify outputs, `AI_SCHEMA_MISMATCH` shape, token totals, receipts, provenance, secret absence by substring scan, plus save-as-Note → fresh-session read-back equality (same owner, new session = second device) and sync-pull containing the Note op.
- [ ] **Step 2: Extend Docker smoke RED path** for vault put → AI run → receipt/usage checks → save-as-note/artifact → fresh-session Note read-back → cancel-gate preservation.
- [ ] **Step 3: Extend `verify-no-secrets.mjs`** with bearer-token and secret-value patterns; wire new canary through CircleCI docker-smoke job.
- [ ] **Step 4: Run GREEN** golden integration on fresh PostgreSQL, full suite, Docker smoke locally.
- [ ] **Step 5: Commit:** `test: add north-star golden workflows and smoke`.

### Task 11: Architecture docs, runbook, README, and Phase 4 gate

**Files:**

- Create: `docs/architecture/phase-4.md`
- Modify: `docs/runbooks/local-development.md`
- Modify: `README.md`
- Modify: `deploy/docker/compose.yml` (comments only if code changed in Task 10)
- Modify: `.circleci/config.yml` (only if CI gate changed in Task 10)

**Docs updates:**

- `docs/architecture/phase-4.md`: `@uw/egress` leaf + acyclic dependency diagram (`egress ← providers`, `egress ← tools`, structural provider injection), provider abstraction, vault envelope encryption (IV/tag/AAD/key versions) + rekey + loss-means-unrecoverable recovery, `secret://` lifecycle including the Local Secrets device boundary, mock-only-behind-explicit-flag rule, AI tool descriptor, structured outputs, crash-safe token accounting with observed-vs-invoiced distinction, Send-to generation rule, receipt redaction guarantee, runtime modes unchanged.
- Runbook: `VAULT_MASTER_KEYS` keyring setup/backup warning (losing every copy = unrecoverable vault; recovery = fresh keyring + delete rows + rotate provider keys + re-enter), `vault:rekey --dry-run` rotation procedure, BYO key flows (local vs vault + local-fails-closed-on-server), AI mock vs real provider env vars (`WORKBENCH_AI_MOCK`, `AI_PROVIDER_BASE_URL`), token-budget tuning + observed-vs-invoice note, troubleshooting (403 `ai`, `LOCAL_SECRET_NOT_AVAILABLE_ON_SERVER`, `AI_SCHEMA_MISMATCH`, `BUDGET_EXCEEDED`, `AI_PROVIDER_NOT_CONFIGURED`, `MOCK_NOT_ALLOWED`).
- README: replace Phase 3 banner with Phase 4 north-star status; document `HTTP -> JSON -> AI -> Note` as supported.

- [ ] **Step 1: Write `docs/architecture/phase-4.md`** from Tasks 1–10 interfaces; no TBD/TODO.
- [ ] **Step 2: Update runbook + README** with vault/AI/Send-to sections; remove stale `phase-3-tools-workflow` branch references to the current branch where they describe active work.
- [ ] **Step 3: Run the final gate from a clean checkout/fresh PostgreSQL:**

```text
npm ci                                          PASS
npm audit --omit=dev --audit-level=high         PASS
npm run verify:workspaces                       PASS
npm run format:check                            PASS
npm run lint                                    PASS
npm run typecheck                               PASS
npm test                                        PASS
npm run build                                   PASS
node scripts/verify-pwa.mjs                     PASS
grep -rn "@uw/providers" packages/tools/src \
  && exit 1 || echo "no tools->providers import" PASS
grep -rn "@uw/tools" packages/providers/src \
  && exit 1 || echo "no providers->tools import" PASS
grep -rn "createMockProvider\|providerId.*mock" apps/server/src \
  | grep -v test | grep -v isMockAllowed \
  && exit 1 || echo "mock behind gate"         PASS
Phase 0-2 browser sync regression               PASS
Phase 3 contract/tool/workflow tests            PASS
Phase 3 PostgreSQL migrations                   PASS
Queue lease/reclaim integration                 PASS
Workflow golden integration                     PASS
Phase 4 AI golden integration                   PASS
HTTP egress/redirect security regression        PASS
AI provider SSRF/secret-leak regression         PASS
Linear workflow + Send-to Chromium E2E          PASS
Two-device AI Note sync Chromium E2E            PASS
Docker Phase 4 vertical smoke                   PASS
Deployment secret-canary scan                   PASS
```

- [ ] **Step 4: Confirm by repository search/log inspection** that no raw password, session token, `Authorization` header, AI key, Vault plaintext, or secret-like config value appears in execution rows, queue rows, provenance, receipts, audit rows, error envelopes, or Docker logs.
- [ ] **Step 5: Commit:** `docs: close phase 4 ai provider`.
- [ ] **Step 6: Open PR `Phase 4: AI Provider` against `main` only after the same head commit has complete green CI evidence.**

## Self-Review

- **Spec coverage:** AI provider abstraction (§19/§27), BYO secrets (§16), AI as Tool (§13/§20 in blueprint), Send to (§10), structured outputs (§9/§11 payload validation), usage accounting (§8 Execution + §13 receipts) each own at least one task above; north-star flow (§1) is Task 10.
- **Deferred intentionally:** MCP/plugin expansion, broader ingestion, arbitrary loops/shell/code, billing/teams/marketplace, Redis, K8s remain non-goals per blueprint §3/§27.
- **Placeholder scan:** no task contains TBD/TODO; each implementation step names exact files/interfaces/verification.
- **Type consistency:** `ai_response`, `AiToolConfig.secretRef`, `ExecutionUsageV2` token fields, `ParsedSecretRef`, `AiProvider`/`AiProviderPort` (structural pair, no cross-import)/`ProviderRequest`/`ProviderResult` with `usageSource` + `providerRequestId`, `VaultStore` (plaintext-in/out, envelope-internal) + `key_version`/`auth_tag` rows, `LocalSecretStore`, `@uw/egress` (`EgressPolicy`, `createEgressPolicy`, `EgressPolicyError`) keep identical names across Tasks 1–11.
- **Review Focus coverage:** secret-in-error, prompt-injected grant, schema mismatch, double-billing retry, provider SSRF each name an owning task and test above.

## Appendix A — Phase 3 audit (2026-09-28, branch `phase-4-ai-provider`)

- **Branch state:** clean tree on `phase-4-ai-provider` tracking `origin/phase-4-ai-provider`; HEAD `84d1ff0 Phase 3: Tool & Workflow Core (#4)`. `main` untouched. No `AGENTS.md` found at any depth — plan assumes repo root docs + runbook as authority.
- **Phase 3 completeness:** packages `@uw/contracts, @uw/context, @uw/tools, @uw/workflow, @uw/execution` match the 2026-09-25 plan Tasks 1–10 (registry with 4 pinned built-ins, egress-gated HTTP, DAG+preflight, durable execution/queue/worker/budgets/receipts, protected APIs, linear UI). `packages/providers` absent, zero `secret://` references, zero AI/provider symbols — Phase 4 starts from a clean seam.
- **Invariants holding:** owner-derived identity (no client owner/role trust), immutable workflow versions, no auto-run on import/save, `content cannot grant permissions` (server `allowedPermissions`, default `[]`), receipts omit payloads/headers/secrets/keys, `from-execution` reads server records with 512 KiB cap, fixture transports default-off behind `WORKBENCH_E2E_FIXTURE`/`WORKBENCH_DOCKER_SMOKE_FIXTURE`.
- **Gaps Phase 4 must close:** (1) `ContextType` has only 5 values — no `ai_response`; (2) `ExecutionUsage` is `{attempts,inputBytes,outputBytes}` — no tokens/cost; (3) no Vault (server) or Local Secret (device) store — BYO impossible; (4) Context Bus/UI `Send to` is workflow-linear only, not universal over artifacts/executions/notes; (5) `from-execution` JSON-serializes any payload — needs `ai_response`-aware Note path; (6) web `initialConfig` knows only HTTP/JSON tools.
- **Security notes for Phase 4:** reuse the existing egress-policy + redirect-revalidation pattern for provider `baseUrl`; resolve `secret://vault/*` only inside the server tool runtime; keep `secret://local/*` server-unavailable by design; extend `verify-no-secrets.mjs` (currently cookie/password/canary only) with bearer/key patterns before closing.

## Appendix B — Phase 3 docs that go stale after Phase 4 merge

1. `README.md` — Phase 3 banner ("under final verification", "no AI tools yet", "Finish Task 11 before Phase 4") and §Phase 3 capabilities must roll to Phase 4 north-star status.
2. `docs/architecture/phase-3.md` — "AI providers and `HTTP -> JSON -> AI -> Note` are deferred to Phase 4" + smoke description covering only `HTTP -> JSON extract` become history; superseded by `docs/architecture/phase-4.md`.
3. `docs/runbooks/local-development.md` — Phase 3 branch name (`phase-3-tools-workflow`), smoke log name (`phase3-docker.log`, canary `phase3-local-canary`), and "no network permission by default, no AI" troubleshooting must be updated to Phase 4 vault/AI/Send-to flows.
4. `docs/superpowers/plans/2026-09-25-phase-3-tools-workflow-core.md` — Task 11 closing gate and "AI intentionally not part of Phase 3" note stay as record but must no longer be read as the active gate; active gate is this plan's Task 11.
5. `docs/superpowers/specs/2026-09-15-universal-workbench-design.md` — §27 roadmap Phase 4 changes from future to implemented; no spec edit required unless scope drifts, but readers should be pointed at `docs/architecture/phase-4.md` after merge.
