# Phase 4 — AI Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add AI provider abstraction, BYO secrets (local + Cloud Vault), AI Tool with structured outputs, Universal Send to, and usage accounting to complete the north-star `HTTP -> JSON -> AI -> Note -> Sync` flow.

**Architecture:** Phase 4 keeps the modular monolith and the Phase 3 rule that AI is a Tool, not a separate subsystem. A new `@uw/providers` package abstracts chat/AI HTTP behind the existing egress policy; `builtin.ai.complete@1.0.0` consumes it through the Tool Registry with pinned versions, typed bindings, preflight permissions, durable execution, receipts, and provenance. Secrets travel only as `secret://scope/name` references and are resolved at the server execution boundary, never persisted in execution rows, receipts, provenance, logs, or sync journals.

**Tech Stack:** Node.js 24 LTS, TypeScript 5.9, Zod 4, Express 5, PostgreSQL 17, Drizzle ORM, React 19/Vite 8 PWA, Vitest 5, Playwright Chromium, npm workspaces, WebCrypto/AES-GCM for Vault encryption.

**Spec:** `docs/superpowers/specs/2026-09-15-universal-workbench-design.md`

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
  "text" | "markdown" | "json" | "api_response" | "artifact_ref" | "ai_response";

interface AiResponsePayload {
  text: string;
  model: string;
  structured?: unknown;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
}

interface AiToolConfig {
  providerId: string;
  model: string;
  prompt: string;
  systemPrompt?: string;
  secretRef: string; // must match secret://(vault|local)/[a-z0-9._-]+
  responseFormat?: { kind: "text" } | { kind: "json"; jsonSchema: Record<string, unknown> };
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
interface ParsedSecretRef { scope: SecretScope; name: string; }
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
  put(ownerId: string, name: string, ciphertext: Buffer, iv: Buffer): Promise<void>;
  get(ownerId: string, name: string): Promise<{ ciphertext: Buffer; iv: Buffer } | null>;
  remove(ownerId: string, name: string): Promise<void>;
  list(ownerId: string): Promise<string[]>;
}
```

Routes (owner-scoped, session auth, no owner ID from JSON):

- `GET /api/vault` → `{ secrets: string[] }` (names only)
- `PUT /api/vault/:name` body `{ value: string }` (1–8 KiB limit) → `{ name }`
- `DELETE /api/vault/:name` → `{ deleted: true }`

Encryption: AES-256-GCM with `VAULT_MASTER_KEY` (base64 32 bytes) from env; per-secret random 12-byte IV; `list` never returns ciphertext; errors never echo values.

- [ ] **Step 1: Write RED migration tests** for owner+name uniqueness, owner isolation, and ciphertext/iv not-null constraints.
- [ ] **Step 2: Write RED API tests** for put→list→delete round-trip, cross-owner 404 concealment, oversize value → 413, missing `VAULT_MASTER_KEY` → 503 without stack leak, and log-scan asserting the raw value appears nowhere in error bodies.
- [ ] **Step 3: Run RED** against fresh PostgreSQL. Expected failure: table/routes missing.
- [ ] **Step 4: Implement migration + repository + routes** through `requireOwner` middleware; `PUT` validates name `^[a-z0-9][a-z0-9._-]{0,127}$`.
- [ ] **Step 5: Run GREEN** database + server tests and `npm run typecheck -w @uw/database -w @uw/server`.
- [ ] **Step 6: Commit:** `feat: add encrypted cloud vault store and APIs`.

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

- [ ] **Step 1: Write RED component/store tests** for put→list(names-only)→get→remove, invalid name rejection, value never appearing in `list()` output, and persistence across reload via fake IndexedDB.
- [ ] **Step 2: Run RED:** `npm test -w @uw/web -- local-secrets.test.ts`. Expected failure: module missing.
- [ ] **Step 3: Implement store + settings screen** with existing AuthGate/project shell styles; no new global state manager.
- [ ] **Step 4: Run GREEN** web tests, typecheck, production build.
- [ ] **Step 5: Commit:** `feat: add device-only local secret store UI`.

### Task 5: `@uw/providers` — provider abstraction + deterministic mock + HTTP provider

**Files:**

- Create: `packages/providers/package.json`
- Create: `packages/providers/tsconfig.json`
- Create: `packages/providers/src/index.ts`
- Create: `packages/providers/src/types.ts`
- Create: `packages/providers/src/mock.ts`
- Create: `packages/providers/src/http-provider.ts`
- Test: `packages/providers/test/providers.test.ts`
- Modify: `scripts/verify-workspaces.mjs`
- Modify: `package.json` (build order: add `@uw/providers` after `@uw/tools`)

**Interfaces:**

- Consumes: `AiToolConfig` (Task 1), `EgressPolicy` from `@uw/tools`, secret value passed in as plain string at call time (never stored).
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
}

interface ProviderResult {
  text: string;
  model: string;
  structured?: unknown;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
}

interface AiProvider {
  readonly id: string;
  complete(req: ProviderRequest): Promise<ProviderResult>;
}
```

`mock` provider id `mock`: deterministic `text: "mock:${model}:${prompt.slice(0,32)}"`, token counts from byte/4 heuristic, honors `json` format by returning `{"echo": prompt}`. HTTP provider: OpenAI-compatible `POST {baseUrl}/chat/completions`, bearer from `secretValue`, manual redirect handling with `EgressPolicy.assertAllowed` per hop, `Authorization` dropped on redirect, timeout via AbortController, 256 KiB response cap, structured errors without secret bytes.

- [ ] **Step 1: Write RED tests** for mock determinism + token math, HTTP success path with injected fetch/DNS doubles (no internet), `baseUrl http://169.254.169.254/` rejection, public→private redirect rejection, timeout abort, oversize response error, and error-body scan proving secret value absent.
- [ ] **Step 2: Run RED:** `npm test -w @uw/providers`. Expected failure: package missing.
- [ ] **Step 3: Implement types/mock/HTTP provider** reusing `createEgressPolicy` from `@uw/tools`; no registry/DB/React deps.
- [ ] **Step 4: Extend workspace verification + root build order.**
- [ ] **Step 5: Run GREEN** providers tests, `npm run verify:workspaces`, full suite.
- [ ] **Step 6: Commit:** `feat: add ai provider abstraction and mock`.

### Task 6: AI Tool executor — `builtin.ai.complete@1.0.0` with structured outputs

**Files:**

- Create: `packages/tools/src/builtin/ai.ts`
- Modify: `packages/tools/src/index.ts`
- Test: `packages/tools/test/ai-tool.test.ts`

**Interfaces:**

- Consumes: `AiProvider` (Task 5), `AiToolConfig` + `ContextType ai_response` (Task 1), `redactSecrets` (Task 2).
- Produces: `createAiTool(deps: { providers: Map<string, AiProvider>; resolveSecret: (ref: string) => Promise<string> }): ToolExecutor` with descriptor:

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

Behavior: input payload becomes prompt context (stringified if JSON); config `prompt` + input combined; `resolveSecret` resolves `secretRef` at run time; `json` format validates provider `structured`/parsed `text` against `jsonSchema` (fail `AI_SCHEMA_MISMATCH`); output envelope type `ai_response` with provenance set by runtime; `usage: {inputBytes, outputBytes}` preserved for budget compat; config validation rejects unknown provider, empty model, `secretRef` malformed, `maxOutputTokens` out of 1–128000.

- [ ] **Step 1: Write RED tests** for text→ai_response happy path (mock), markdown/json inputs, json-schema pass/fail, missing secret → typed error without value, secret-like config never echoed in error, and idempotency descriptor === `keyed`.
- [ ] **Step 2: Run RED:** `npm test -w @uw/tools -- ai-tool.test.ts`. Expected failure: `createAiTool` missing.
- [ ] **Step 3: Implement executor** with runtime schemas at input/config boundaries; Review Focus #3 test lives here.
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

- [ ] **Step 1: Write RED tests** for two-step `text -> AI -> text` token aggregation, budget overflow → structured `BUDGET_EXCEEDED` before scheduling the next step, receipt containing token totals + tool versions but no prompt-secret substring, reclaimed-lease idempotency (tokens counted once), and Review Focus #2 (AI output claiming permissions does not grant them — engine re-checks `permissions` set per step).
- [ ] **Step 2: Run RED:** `npm test -w @uw/execution -- usage-accounting.test.ts`. Expected failure: token fields missing.
- [ ] **Step 3: Implement budget/engine/receipt changes** keeping legacy `{attempts,inputBytes,outputBytes}` readable (default tokens to 0).
- [ ] **Step 4: Run GREEN** execution tests + PostgreSQL integration + full suite.
- [ ] **Step 5: Commit:** `feat: add ai usage accounting to execution engine`.

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

- Consumes: `VaultStore` (Task 3), `AiProvider` map (Task 5), `createAiTool` (Task 6), engine with token usage (Task 7).
- Produces: `resolveSecretResource(ref, ownerId)` — `vault:` reads via VaultStore + decrypts, `local:` throws `LOCAL_SECRET_NOT_AVAILABLE_ON_SERVER` (local keys never leave the device, so server workflows must use `secret://vault/*`); registry includes mock AI tool in all envs + HTTP AI tool in production composition; `workflowPermissions` default stays `[]` (tests grant `["network","ai"]` explicitly); new route `POST /api/projects/:projectId/documents/from-execution` saves a completed `ai_response`/`text`/`markdown` output as a Document via `documentService` (server-read execution record, never client bytes).

- [ ] **Step 1: Write RED API tests** for catalog containing `builtin.ai.complete@1.0.0`, run with missing `ai` permission → 403 without enqueue, run with `secret://local/k` on server → structured failure without secret bytes, `from-execution` with `ai_response` → Artifact, `documents/from-execution` with `ai_response` → Document, cross-owner execution concealment.
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

- [ ] **Step 1: Write RED component tests** for Send-to menu listing AI/Note/Artifact candidates for `ai_response`, excluding AI tool without `ai` grant, AI config form validation (bad `secretRef`, JSON schema syntax error), usage display after run, save-as-note flow.
- [ ] **Step 2: Write RED Playwright flow** creating `HTTP(fixture) -> JSON extract -> AI(mock) -> Note` against the deterministic stack endpoint.
- [ ] **Step 3: Run RED** component/browser tests; failure must be missing Phase 4 UI/API behavior.
- [ ] **Step 4: Implement client + components** reusing AuthGate/project shell; no new state manager or graph library; mobile-first list patterns.
- [ ] **Step 5: Run GREEN** component tests, typecheck, production build, Playwright flow.
- [ ] **Step 6: Commit:** `feat: add universal send-to and ai workflow ui`.

### Task 10: Golden north-star, Docker smoke, secret-canary hardening

**Files:**

- Create: `packages/execution/test/golden-ai.integration.test.ts`
- Modify: `scripts/smoke-http.mjs`
- Modify: `scripts/verify-no-secrets.mjs` (add AI-key canary + `Authorization: Bearer` + `secret://` value patterns)
- Modify: `deploy/docker/compose.yml` (document `VAULT_MASTER_KEY` wiring; no real keys committed)
- Modify: `.circleci/config.yml`
- Test: gate scripts only (no new unit files beyond golden test)

**Golden workflows added in Phase 4:**

1. `HTTP -> JSON extract -> AI(mock) -> Note` (north-star, text output).
2. `JSON -> AI(mock, json schema) -> Artifact` (structured outputs + usage assertions).
3. `AI with bad secretRef -> structured Error` (no retry storm, no leak).

Smoke: with `WORKBENCH_DOCKER_SMOKE_FIXTURE=1` + `VAULT_MASTER_KEY` test key + `SMOKE_SECRET_CANARY`, create owner/project, `PUT /api/vault/e2e-ai` with canary value, run HTTP→JSON→AI workflow, assert receipt token totals + provenance length ≥ 3, save AI output as Note + Artifact, verify canary absent from `docker logs` and from receipt/step API bodies.

- [ ] **Step 1: Write RED golden integration tests** with mock provider; verify outputs, `AI_SCHEMA_MISMATCH` shape, token totals, receipts, provenance, and secret absence by substring scan.
- [ ] **Step 2: Extend Docker smoke RED path** for vault put → AI run → receipt/usage checks → save-as-note/artifact → cancel-gate preservation.
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

- `docs/architecture/phase-4.md`: provider abstraction, vault envelope encryption, `secret://` lifecycle, AI tool descriptor, structured outputs, token accounting, Send-to generation rule, receipt redaction guarantee, runtime modes unchanged.
- Runbook: `VAULT_MASTER_KEY` setup/backup warning (losing it = unrecoverable vault), BYO key flows (local vs vault), AI mock vs real provider env vars, token-budget tuning, troubleshooting (403 `ai`, `LOCAL_SECRET_NOT_AVAILABLE_ON_SERVER`, `AI_SCHEMA_MISMATCH`, `BUDGET_EXCEEDED`).
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
Phase 0-2 browser sync regression               PASS
Phase 3 contract/tool/workflow tests            PASS
Phase 3 PostgreSQL migrations                   PASS
Queue lease/reclaim integration                 PASS
Workflow golden integration                     PASS
Phase 4 AI golden integration                   PASS
HTTP egress/redirect security regression        PASS
AI provider SSRF/secret-leak regression         PASS
Linear workflow + Send-to Chromium E2E          PASS
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
- **Type consistency:** `ai_response`, `AiToolConfig.secretRef`, `ExecutionUsageV2` token fields, `ParsedSecretRef`, `AiProvider`/`ProviderRequest`/`ProviderResult`, `VaultStore`, `LocalSecretStore` keep identical names across Tasks 1–11.
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
