# Phase 4 Architecture — AI Provider

> Implementation reference for the `phase-4-ai-provider` branch. Phase 4 adds a
> BYO-key AI provider seam, server vault envelope encryption, the AI tool with
> structured outputs, execution token accounting, and Universal Send-to. The
> release boundary is not closed until the Task 11 full gate — including the
> golden AI workflows, the two-device Chromium E2E, the Docker Phase 4 smoke,
> and same-commit CI — is verified.

## Scope and package boundaries

Phase 4 keeps the Phase 3 tool/workflow core and the Phase 2 local-first sync
unchanged, and adds two leaf packages plus AI behavior in existing ones:

| Package         | Responsibility                                                                       |
| --------------- | ------------------------------------------------------------------------------------ |
| `@uw/egress`    | Standalone network policy (DNS allow-lists, private-address and redirect checks).    |
| `@uw/providers` | `AiProvider` port, deterministic mock provider, OpenAI-compatible HTTP provider.     |
| `@uw/tools`     | `builtin.ai.complete@1.0.0` built on an injected provider port (unchanged registry). |
| `@uw/execution` | Token aggregation, token budgets, redacted step persistence.                         |
| `@uw/database`  | Vault envelope store plus keyring rotation support.                                  |
| `apps/server`   | Secret resolution, provider composition, Send-to routes, sync fan-out.               |
| `apps/web`      | AI step editor, preflight display, usage display, Universal Send-to menu.            |

Dependency direction (acyclic, enforced by the Task 11 gate):

```text
egress <- providers
egress <- tools
providers + tools <- server (composition only; structural port, no cross-import)
```

`@uw/tools` never imports `@uw/providers` and `@uw/providers` never imports
`@uw/tools`. The server composes them through the structural `AiProviderPort`
interface with a compile-time assertion; a static grep gate fails the build if
either direction gains an import.

## Provider abstraction

`AiProvider.complete(request)` takes the model, prompt, response format, token
and timeout budgets, the resolved secret value, and an abort signal, and
returns text, an optional structured value, token usage, a usage source, and a
provider request id. `ProviderRequest`/`ProviderResult` are the only shared
shapes; the mock and HTTP implementations share no code with the tool.

- The mock provider (`id: "mock"`) returns deterministic
  `mock:<model>:<first-32-chars>` text with byte/4 estimated token math and
  `usageSource: "estimated"`. For JSON response formats it echoes
  `{ echo: <prompt> }` as the structured value. Construction throws
  `MOCK_NOT_ALLOWED` unless `isMockAllowed()`: the smoke-scoped
  `WORKBENCH_DOCKER_SMOKE_FIXTURE=1` flag opens it anywhere (mirroring the
  fixture HTTP tool), otherwise `NODE_ENV=test` plus one of
  `WORKBENCH_AI_MOCK`, `WORKBENCH_E2E_FIXTURE` is required. Production without
  the smoke flag never serves the mock, so `providerId: "mock"` fails closed
  as an unknown provider there.
- The HTTP provider speaks OpenAI-compatible `chat/completions` over the
  shared egress policy: base URLs are allow-listed, DNS is pinned per request,
  private and link-local destinations are refused, redirects re-resolve and
  re-validate, and non-2xx responses map to structured provider errors without
  response bodies. Timeouts abort the request; aborts never retry.

## Vault envelope encryption and secret lifecycle

`secret://vault/<name>` values are owner-scoped rows encrypted with
AES-256-GCM: 12-byte IV, 16-byte auth tag, `key_version`, and
owner+name-bound additional authenticated data. Callers handle plaintext
in and out; IV/tag bytes never leave the VaultStore. Key versions come from
the `VAULT_MASTER_KEYS` keyring (`VAULT_MASTER_KEY` legacy single-key form is
version 1). Rotation is append-new-version plus `vault:rekey --dry-run`
verification followed by live re-encryption; losing every copy of the keyring
makes the vault unrecoverable by design — recovery is a fresh keyring, row
deletion, provider-key rotation, and re-entry (see the runbook).

`secret://` lifecycle:

1. Authoring: vault names are created with `PUT /api/vault/:name`; device
   secrets live in the browser LocalSecretStore and are never transmitted.
2. Reference: AI node configs carry `secretRef` strings. Names are not
   secrets; values never appear in configs, logs, receipts, or errors.
3. Resolution: `resolveSecretResource(ref, ownerId, vaultStore)` runs inside
   the server tool runtime. `vault:` decrypts via the VaultStore;
   `local:` throws `LOCAL_SECRET_NOT_AVAILABLE_ON_SERVER` — local keys cannot
   leave the device, so server runs must use `secret://vault/*`. Malformed
   refs and unknown names fail closed as `INVALID_CONFIG` with fixed
   messages; upstream failures pass through `redactSecrets` first.
4. Use: the plaintext value travels only in the provider request inside the
   tool call and is never persisted — step rows store redacted input contexts,
   outputs carry counts and text, and receipts omit payloads and keys.

## AI tool descriptor

`builtin.ai.complete@1.0.0` accepts `text`, `markdown`, and `json`, produces
`ai_response`, requires the `ai` permission, and is idempotency-`keyed`. Its
config carries `providerId`, `model`, `prompt`, optional `systemPrompt`,
`secretRef`, a text/JSON `responseFormat` with an optional JSON schema, and
`maxOutputTokens`. Validation rejects unknown providers, bad refs, empty
prompts, and schema violations before any secret or network use; every
failure is a structured code (`AI_PROVIDER_NOT_CONFIGURED`,
`AI_SCHEMA_MISMATCH`, `INVALID_CONFIG`,
`LOCAL_SECRET_NOT_AVAILABLE_ON_SERVER`).

Structured outputs: for JSON formats the tool prefers the provider's
structured value and otherwise parses the text, then validates the value
against the node schema. Schema or parse failures are `AI_SCHEMA_MISMATCH`
and never retry. The `ai_response` envelope carries `text`, `model`,
`usage`, `usageSource`, and `providerRequestId`.

`content cannot grant permissions` still holds: preflight and per-step
`runTool` checks use the server grant, and AI output text claiming grants —
including prompt-injected `{"grant": ...}` payloads — never widens it.

## Crash-safe token accounting

`ExecutionUsage` extends `{attempts, inputBytes, outputBytes}` with
`promptTokens`, `completionTokens`, and `totalTokens` (legacy records default
to zero). The engine sums token fields only from completed `ai_response`
payloads, recomputed from a fresh store load on every `process()` entry, so
interrupted attempts contribute zero, reclaimed leases reusing completed steps
never double-count, and a crash between provider billing and step commit bills
at-least-once while counting exactly once. Observed usage is a local ledger,
not an invoice: provider-side metering may differ (retried attempts, rounding),
and `estimated` sources are surfaced with a `~` marker in the UI rather than
presented as metered totals.

Budgets gain `maxTotalTokens` (default 200,000, composition-tunable; the run
API accepts steps/duration/bytes only). The cap is checked pre-step before
scheduling and post-step after aggregating; overflow fails structured
`BUDGET_EXCEEDED` before further work is enqueued. Non-retryable codes
(`LOCAL_SECRET_NOT_AVAILABLE_ON_SERVER`, `AI_SCHEMA_MISMATCH`, `BUDGET_*`,
`INVALID_*`, `PERMISSION_DENIED`, `CANCELLED`) never retry, and workerless
single-flight execution keeps exactly-once local counting.

## Universal Send-to generation rule

Send-to candidates are generated from Context Bus compatibility plus the
server's granted permissions — never hard-coded per screen. A tool is listed
when the output type is in its `accepts` and every required permission is
granted; note/artifact saves are offered for `ai_response`, `text`, and
`markdown` outputs read back from completed, owner-scoped execution records
(512 KiB cap). Every artifact, execution output, and note renders the same
menu: the AI tool appears for text-family outputs with the `ai` grant, while
`ai_response` outputs offer Save as Note (`documents/from-execution`) and
Save as Artifact (`artifacts/from-execution`).

Server-saved notes also fan out as `document.create` sync upserts, so every
device pulls them exactly like normal documents — this is what the two-device
E2E and the Docker smoke assert.

## Receipt redaction guarantee

Receipts carry step ids, tool ids and versions, statuses, output context ids,
provenance edges, error codes, and normalized usage including token totals —
never configs, payloads, headers, keys, prompt text, or secret values. Step
persistence stores `redactSecrets(inputContext)` snapshots; numeric usage
fields survive redaction while secret-like keys become `[REDACTED]`. The
secret-canary gate (`verify-no-secrets.mjs`, extended in Phase 4 with the AI
key canary, bearer, and secret-value patterns) scans deployment logs, and the
golden and smoke suites substring-scan execution views, receipts, and sync
payloads for canary material.

## Runtime modes

Unchanged: `APP_MODE=all` runs API, sync WebSocket, and worker; `api` omits
the worker; `worker` polls the shared PostgreSQL leased queue without an HTTP
listener. The queue still needs PostgreSQL; there is no Redis dependency.

## Non-goals carried forward

MCP/plugin expansion, broader ingestion, arbitrary loops/shell/code,
billing/teams/marketplace, Redis, and Kubernetes remain out of scope per the
product blueprint.
