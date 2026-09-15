# Universal Workbench

Universal Workbench is a local-first, self-hosted-first workspace for connecting tools without losing project context or provenance.

The project is currently at **Phase 0 — Foundation**. Product-domain features such as Projects, Artifacts, local-first sync, workflows, AI providers, MCP, and plugins deliberately remain outside this phase.

## Phase 0 stack

- Node.js 24 LTS
- npm workspaces
- TypeScript
- React + Vite PWA
- Express API
- PostgreSQL + Drizzle boundary
- Vitest
- Docker Compose reference deployment

## Repository layout

```text
apps/web          PWA client
apps/server       Express application
packages/contracts shared runtime contracts
packages/database PostgreSQL boundary
packages/shared    deterministic shared primitives
deploy/docker      canonical self-host deployment
docs               architecture, runbooks, specs, and plans
```

See `docs/runbooks/local-development.md` for startup and verification commands and `docs/superpowers/specs/2026-09-15-universal-workbench-design.md` for the approved product blueprint.
