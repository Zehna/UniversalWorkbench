# Phase 3 Architecture — Tool & Workflow Core

Phase 3 adds a trusted execution substrate on top of the Phase 2 local-first workspace.

The browser still owns local-first authoring and sync. Tool and workflow execution is server-authoritative and durable.

## System boundary

The Phase 3 flow is:

```text
local-first workflow document
        |
        v
canonical synced workflow revision
        |
        v
WorkflowService preflight
        |
        v
durable Execution + Step rows
        |
        v
PostgreSQL queue
        |
        v
ExecutionWorker
        |
        v
version-pinned ToolRunner
        |
        v
immutable outputs / receipts / provenance
```

Phase 3 deliberately does not add AI providers, a secret vault, MCP/plugins, arbitrary code execution, Redis, graph editing, workflow cycles, scheduling, or unrestricted LAN HTTP.

## Packages

Phase 3 adds four domain packages:

- `@uw/context`: typed Context Envelopes and compatibility primitives.
- `@uw/tools`: Tool Contract, deterministic registry, permissions, and trusted built-ins.
- `@uw/execution`: durable execution state, queue ports, worker, retry/budget/cancellation, outputs, receipts, and provenance ports.
- `@uw/workflow`: DAG validation/planning, canonical workflow preflight, scheduling, and workflow lifecycle.

`@uw/database` provides PostgreSQL adapters. `@uw/server` owns composition, HTTP routes, and process runtime. `@uw/web` owns local-first workflow authoring and execution UI.

Domain packages do not import Express or Drizzle.

## Context Envelope

Tool boundaries use versioned runtime-validated Context Envelopes.

Core Phase 3 context types are:

```text
text
markdown
json
api-response
artifact-ref
note-ref
error
```

Envelope provenance can reference project, execution, step, parent contexts, and immutable artifacts.

Inline JSON/text is bounded. HTTP body bytes are not embedded in the envelope; they are stored as immutable Artifacts and referenced from `api-response`.

## Tool registry

Every trusted tool is identified by exact `id@version`.

Phase 3 registers:

```text
builtin.http.request@1
builtin.json.parse@1
builtin.json.select@1
builtin.text.template@1
builtin.note.write@1
```

Workflow revisions pin the exact tool version. Execution never silently selects a newer version.

Compatibility is type-driven and deterministic. The web editor uses the same compatibility endpoint as the Context Bus rather than maintaining a screen-specific list.

When more than one input port accepts an output type, linear authoring prefers the most specific compatible port. This prevents broad multi-type ports from shadowing a dedicated port such as the JSON input on Text Template.

## Workflow documents

Workflow definitions are revisioned `workflow` Documents and participate in the Phase 2 local-first sync model.

A workflow can be authored offline, but it cannot run until:

- its local mutation is ACKed;
- it has no unresolved conflict;
- the browser is online; and
- the requested revision is the canonical current server revision.

The server repeats validation before enqueueing. Client run eligibility is a UX gate, not an authorization boundary.

## DAG execution

Workflow definitions use nodes and edges even though the Phase 3 UI is linear-first.

Validation checks:

- unique node IDs;
- exact registered tool versions;
- valid ports and compatible types;
- required input bindings;
- no self-loop or cycle;
- capability policy;
- execution budget;
- terminal output/side-effect structure.

The planner produces deterministic topological order, dependencies, dependents, roots, and terminals.

The Phase 3 failure policy is fail-fast.

## Durable executions

Execution kinds:

```text
tool
workflow
```

Execution lifecycle:

```text
queued -> running -> succeeded
                 -> failed
                 -> cancelled
                 -> timed_out
```

Each workflow node has a durable step row with its own pinned tool version, attempt count, status, sanitized error, usage, input context IDs, and output context IDs.

Terminal execution states do not transition back to running.

## PostgreSQL queue

The queue is PostgreSQL-backed.

Workers claim available work with row locking and `SKIP LOCKED`, then attach a lease owner and expiry. Active leases are exclusive; expired leases are reclaimable.

Queue completion and retry operations are guarded by both job ID and lease owner.

A reclaimed terminal step does not rerun the tool. The engine reconstructs any missing terminal receipt and replays the workflow lifecycle idempotently before completing the queue job.

Redis is intentionally not required.

## Runtime modes

`APP_MODE` supports:

- `all`: HTTP API + sync WebSocket + execution worker.
- `api`: HTTP API + sync WebSocket, no execution worker.
- `worker`: execution worker only, no HTTP/WebSocket listener.

The canonical Docker deployment uses `all`.

The permanent worker-mode process verification seeds a queued deterministic tool execution in API mode, stops the API, starts worker-only mode, confirms the HTTP port stays closed, and waits for the queued execution to succeed.

## Retry, timeout, cancellation, and budgets

Failures are normalized to structured execution error codes.

Retry policy is bounded and method-aware. Transient GET/HEAD failures may retry. Ambiguous non-idempotent HTTP writes are not automatically replayed.

Automatic attempts are capped at three.

Budgets constrain wall-clock duration, steps, attempts, output bytes, and HTTP request count.

Cancellation is durable. Workers check cancellation before work and during cancellable execution. HTTP and long-running runners receive an AbortSignal.

## Safe public HTTP

`builtin.http.request@1` is a real public HTTP client with deny-by-default egress.

It rejects:

- non-HTTP(S) schemes;
- URL userinfo;
- credential-like query parameters;
- Authorization, Cookie, Proxy-Authorization, and API-key-style credential headers;
- loopback, private, link-local, carrier-grade NAT, metadata, multicast, unspecified, and other non-public IP ranges.

All DNS answers are validated. The chosen public address is pinned into the connection while the original hostname is preserved for Host/SNI.

Every redirect is parsed, DNS-resolved, and validated again before a connection is attempted.

Set-Cookie and other credential-bearing response headers are removed before persistence.

Response size, redirects, and timeout are bounded.

There is no product configuration that enables localhost/private-network bypass in Phase 3.

## Built-in deterministic tools

### JSON Parse

Parses strict UTF-8 JSON from text or an HTTP body Artifact. It does not evaluate JavaScript or JSON5.

### JSON Select

Uses RFC 6901 JSON Pointer. It does not execute jq or arbitrary expressions.

### Text Template

Supports only constrained placeholders:

```text
{{input}}
{{json:/pointer}}
```

It has no eval/expression/filesystem/network capability.

### Note Write

Creates a canonical project note through the existing Action Layer-backed document writer.

The note document ID is derived deterministically from the step execution identity so lease replay does not create a duplicate side effect.

The resulting `note-ref` is persisted as an execution output and rendered in the execution timeline. Server-generated notes are canonical server documents; Phase 3 does not claim a separate server-originated local-sync journal for those side effects.

## Outputs, receipts, and provenance

Tool outputs are persisted before a step transitions to succeeded.

Execution detail exposes output Context Envelopes so the web timeline can display output references such as generated `note-ref` values.

Each terminal step gets one immutable receipt containing the pinned tool version, input/output context IDs, capabilities, attempts, timestamps, sanitized error, and usage.

Provenance edges are append-only. Downstream derived contexts record `derived-from` edges from parent context IDs.

Receipts and provenance do not contain raw passwords, session cookies, Authorization values, or secret values.

## Web UX

The Phase 3 workflow editor is list-first and mobile-friendly:

- add compatible step;
- edit constrained JSON configuration;
- move up/down;
- remove;
- save locally;
- wait for canonical sync;
- validate;
- run;
- inspect execution timeline, attempts, output references, receipts, and provenance counts.

No graph editor dependency is required.

## Verification strategy

Permanent Phase 3 gates are intentionally split so security is not weakened for deterministic tests.

### Tool golden chain

The tools test suite runs:

```text
HTTP injected transport
  -> immutable response Artifact
  -> JSON Parse
  -> JSON Select
  -> Text Template
  -> Note Write
```

The HTTP Tool still uses its production behavior; only its transport port is injected in the test. Separate safe-egress tests verify DNS pinning, private redirects, header redaction, body limits, timeout, and cancellation.

No `ALLOW_LOCALHOST` or private-network product bypass exists.

### Docker vertical workflow smoke

The canonical Docker stack runs a deterministic:

```text
Text Template -> Note Write
```

through the real PostgreSQL queue and `APP_MODE=all` worker.

The smoke verifies:

- exact canonical workflow revision pin;
- both steps succeed;
- canonical generated note content;
- two terminal receipts;
- provenance;
- credential-free receipt payload;
- all existing Phase 2 sync/security behavior.

### Browser workflow gate

Real Chromium creates a local-first workflow, syncs it, runs it, waits for terminal success, and sees the generated `note-ref` in the execution timeline.

A second browser context verifies the project/workflow sync and reads the same canonical execution result.

### Existing regression gates

Phase 2 browser sync, OPFS/IndexedDB fallback, conflicts, tombstones, revocation, PWA build, Docker secret-canary scan, and the full PostgreSQL/unit suite remain permanent.

## Phase 4 boundary

Phase 4 may add AI providers, secret references/vault integration, and the polished universal `Send to...` surface on top of these contracts.

It must reuse the Phase 3 Tool Registry, execution queue, receipts, provenance, capability checks, and Context Bus rather than creating a parallel execution path.
