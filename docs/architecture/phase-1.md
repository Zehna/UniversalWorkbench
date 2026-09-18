# Phase 1 Architecture: Project and Data Core

Phase 1 turns the Phase 0 foundation into a private single-owner workbench with projects, revisioned notes, immutable artifact storage, authenticated data APIs, and a mobile-first PWA flow.

## Runtime boundaries

The deployment remains a modular monolith:

- `web` serves the React PWA and proxies `/api/*` to the application.
- `app` runs the Express API and composes auth, project, document, artifact, storage, and PostgreSQL repositories.
- `postgres` is the canonical server database.
- `migrate` is a one-shot deployment process that applies checked-in Drizzle migrations before `app` starts.
- managed artifact bytes live outside PostgreSQL in the configured storage directory; Compose persists them in `artifacts-data`.

Database schema migration is deliberately not part of API process startup. Deployment orchestration must make migration success an explicit prerequisite.

## Authentication and ownership

A fresh installation is uninitialized. The setup endpoint creates exactly one owner and issues the same HttpOnly session cookie used by normal login. Once initialized, setup cannot create another owner.

Protected project, document, and artifact routes resolve the owner from the server-side session. Client-supplied owner IDs are never trusted.

## Project and note data flow

Projects are the top-level ownership boundary. Notes are mutable documents whose content is represented by immutable revisions.

A note update carries `baseRevisionId`. The document service compares that revision with the current revision before writing. A stale base produces `REVISION_CONFLICT` with HTTP 409, preserving both the server state and the client's unsaved draft.

The Phase 1 PWA mirrors this contract: it keeps the current base revision in memory, surfaces a conflict notice, and only replaces local text when the user explicitly reloads the current server revision.

## Artifact storage

Artifact metadata and ownership are stored in PostgreSQL while bytes are stored through the storage abstraction. The canonical Compose deployment sets:

```text
ARTIFACTS_DIR=/app/data/artifacts
```

and mounts the `artifacts-data` named volume there. The runtime image creates the directory with ownership suitable for the non-root `node` user.

## Deployment ordering

Canonical startup order is:

```text
postgres healthy
      ↓
migrate exits 0
      ↓
app healthy
      ↓
web
```

If migration fails, `app` does not start. This prevents a healthy-looking API from serving against an unknown schema state.

## Phase 1 deployment smoke

The Docker smoke is intentionally stateful and runs against an ephemeral stack. It verifies:

1. the database starts uninitialized;
2. a random owner is created without printing credentials;
3. the session cookie authorizes project creation;
4. a note is created and updated from revision 1 to revision 2;
5. revision history contains two revisions;
6. a stale update returns HTTP 409 with `REVISION_CONFLICT`;
7. logout revokes the session; and
8. the protected project route returns HTTP 401 afterward.

The CI teardown removes volumes after the run, so every smoke begins from a clean deployment.
