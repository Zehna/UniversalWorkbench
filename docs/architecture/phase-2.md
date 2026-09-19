# Phase 2 Architecture — Local-First & Sync

Phase 2 makes the browser workspace local-first while preserving a canonical PostgreSQL server for durable cross-device synchronization.

## Local persistence

The PWA selects one of two local backends:

- `opfs-sqlite`: SQLite WASM in a worker backed by OPFS when browser capabilities and cross-origin isolation are available.
- `indexeddb`: durable fallback when OPFS/SQLite cannot be used.

The local store contains projects, note documents and revisions, pending operations, conflicts, tombstones, device metadata, and the last durable sync cursor.

## Durable operation lifecycle

User mutations write locally first and append a sync operation in the same local transaction.

Operation state progresses conceptually as:

`pending -> sent -> acked`

or:

`pending -> sent -> conflict`

Local UI state is not rolled back when the network fails. Pending operations remain durable across reloads.

## Device identity

Each local browser store owns one client-generated device ID for the current owner. The server stores active/revoked devices.

A sync mutation is accepted only when:

1. the request has an authenticated owner session;
2. the operation device belongs to that owner;
3. the device is active.

Revoked devices remain revoked even if the same ID attempts to register again.

## Cursor semantics

The server persists every applied operation or conflict as one immutable sync change with a monotonic decimal cursor.

Clients persist the highest applied cursor. Recovery uses:

`GET /api/sync/changes?cursor=<last-cursor>`

Changes are returned strictly after the supplied cursor and in ascending order.

Exact operation-ID replay is idempotent: the original change is returned and the durable cursor does not advance.

## WebSocket transport

`/api/sync/socket` is an authenticated WebSocket transport.

The client sends `HELLO` with its device ID and last cursor. The server replies with `READY` and replays missed changes through the latest cursor.

WebSocket delivery is an optimization, not the durable source of truth. HTTP catch-up remains authoritative after reconnect or missed real-time delivery.

## Conflict policy

The server uses compare-and-swap revisions.

A stale update never overwrites canonical state. Instead the server persists a conflict change containing:

- incoming local payload;
- current canonical snapshot.

The browser preserves the local edit and exposes explicit resolution:

- keep local and retry against the current canonical revision;
- use server version.

Conflict changes created by another device do not become local conflicts unless their operation ID belongs to a pending operation on this device.

## Tombstones

Deletes produce durable tombstones.

Once an entity is tombstoned, an older offline update cannot resurrect it. The attempted update becomes a conflict referencing the deleted canonical state.

## Diagnostics

The coordinator exposes a non-secret diagnostics snapshot:

```ts
interface SyncDiagnostics {
  deviceId: string;
  backend: "opfs-sqlite" | "indexeddb";
  cursor: string;
  pendingOperations: number;
  conflicts: number;
  websocketState: "closed" | "connecting" | "open";
  lastAckAt: string | null;
  lastErrorCode: string | null;
}
```

Diagnostics never include passwords, raw session tokens, Cookie headers, or operation secrets.

## Security boundaries

- Sync routes require the authenticated owner session.
- Every mutation is additionally bound to an active device.
- Raw session tokens are stored server-side only as hashes.
- Sync changes contain domain mutation payloads, not authentication credentials.
- Docker smoke uses a credential canary and scans deployment logs for password/session leakage.
- The browser treats WebSocket as non-durable and always has HTTP recovery.

## Deployment

The canonical Docker profile remains:

`PostgreSQL -> one-shot migrations -> Express app -> nginx/PWA`

nginx emits the COOP/COEP headers required by SQLite OPFS and proxies `/api/sync/socket` as a WebSocket upgrade.

## Verification

Permanent Phase 2 gates include:

- dependency audit;
- workspace/format/lint/typecheck;
- unit and PostgreSQL integration tests;
- production build and PWA verification;
- real Chromium local persistence;
- IndexedDB fallback persistence;
- multi-device sync;
- offline reconnect;
- conflict preservation;
- tombstone no-resurrection;
- revoked-device rejection;
- HTTP catch-up;
- Docker vertical sync smoke;
- deployment log credential-canary scan.
