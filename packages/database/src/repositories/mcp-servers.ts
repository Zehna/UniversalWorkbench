import { randomUUID } from "node:crypto";
import type {
  CreateMcpServerRequest,
  McpServerConfig,
  UpdateMcpServerRequest,
} from "@uw/contracts";
import { McpServerConfigSchema } from "@uw/contracts";
import type { Pool, QueryResultRow } from "pg";

export interface McpServerRepository {
  create(
    ownerId: string,
    projectId: string,
    input: CreateMcpServerRequest,
  ): Promise<McpServerConfig>;
  getById(
    ownerId: string,
    projectId: string,
    serverId: string,
  ): Promise<McpServerConfig | null>;
  listByProject(ownerId: string, projectId: string): Promise<McpServerConfig[]>;
  update(
    ownerId: string,
    projectId: string,
    serverId: string,
    input: UpdateMcpServerRequest,
  ): Promise<McpServerConfig | null>;
  remove(
    ownerId: string,
    projectId: string,
    serverId: string,
  ): Promise<boolean>;
  /** Alias for remove to match task naming (delete). */
  delete(
    ownerId: string,
    projectId: string,
    serverId: string,
  ): Promise<boolean>;
}

interface McpServerRow extends QueryResultRow {
  id: string;
  owner_id: string;
  project_id: string;
  name: string;
  enabled: boolean;
  transport_config: unknown;
  secret_refs: unknown;
  created_at: Date;
  updated_at: Date;
}

const MCP_SERVER_COLUMNS = `
  id,
  owner_id,
  project_id,
  name,
  enabled,
  transport_config,
  secret_refs,
  created_at,
  updated_at
`;

function toIso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function mapRow(row: McpServerRow): McpServerConfig {
  return McpServerConfigSchema.parse({
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    enabled: row.enabled,
    transportConfig: row.transport_config,
    secretRefs: Array.isArray(row.secret_refs) ? row.secret_refs : [],
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  });
}

export async function ensureMcpServersTable(pool: Pool): Promise<void> {
  await pool.query(`
    create table if not exists mcp_servers (
      id uuid primary key,
      owner_id uuid not null,
      project_id uuid not null,
      name text not null,
      enabled boolean not null default true,
      transport_config jsonb not null,
      secret_refs jsonb not null default '[]'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create index if not exists mcp_servers_owner_project_idx
      on mcp_servers (owner_id, project_id);
  `);
}

export function createInMemoryMcpServerRepository(
  initial: McpServerConfig[] = [],
): McpServerRepository {
  const store = new Map<string, { ownerId: string; server: McpServerConfig }>();
  for (const server of initial) {
    const projectId = server.projectId ?? "";
    store.set(server.id, {
      ownerId: "__seed__",
      server: { ...server, projectId: projectId || undefined },
    });
  }

  async function create(
    ownerId: string,
    projectId: string,
    input: CreateMcpServerRequest,
  ): Promise<McpServerConfig> {
    const now = new Date().toISOString();
    const server = McpServerConfigSchema.parse({
      id: randomUUID(),
      projectId,
      name: input.name,
      enabled: input.enabled ?? true,
      transportConfig: input.transportConfig,
      secretRefs: input.secretRefs ?? [],
      createdAt: now,
      updatedAt: now,
    });
    store.set(server.id, { ownerId, server });
    return server;
  }

  async function getById(
    ownerId: string,
    projectId: string,
    serverId: string,
  ): Promise<McpServerConfig | null> {
    const entry = store.get(serverId);
    if (!entry || entry.ownerId !== ownerId) return null;
    if ((entry.server.projectId ?? projectId) !== projectId) return null;
    return entry.server;
  }

  async function listByProject(
    ownerId: string,
    projectId: string,
  ): Promise<McpServerConfig[]> {
    return [...store.values()]
      .filter(
        (entry) =>
          entry.ownerId === ownerId &&
          (entry.server.projectId ?? projectId) === projectId,
      )
      .map((entry) => entry.server)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  async function update(
    ownerId: string,
    projectId: string,
    serverId: string,
    input: UpdateMcpServerRequest,
  ): Promise<McpServerConfig | null> {
    const existing = await getById(ownerId, projectId, serverId);
    if (!existing) return null;
    const updated = McpServerConfigSchema.parse({
      ...existing,
      name: input.name ?? existing.name,
      enabled: input.enabled ?? existing.enabled,
      transportConfig: input.transportConfig ?? existing.transportConfig,
      secretRefs: input.secretRefs ?? existing.secretRefs,
      updatedAt: new Date().toISOString(),
    });
    store.set(serverId, { ownerId, server: updated });
    return updated;
  }

  async function remove(
    ownerId: string,
    projectId: string,
    serverId: string,
  ): Promise<boolean> {
    const existing = await getById(ownerId, projectId, serverId);
    if (!existing) return false;
    store.delete(serverId);
    return true;
  }

  return {
    create,
    getById,
    listByProject,
    update,
    remove,
    delete: remove,
  };
}

export function createPostgresMcpServerRepository(
  pool: Pool,
): McpServerRepository {
  async function create(
    ownerId: string,
    projectId: string,
    input: CreateMcpServerRequest,
  ): Promise<McpServerConfig> {
    await ensureMcpServersTable(pool);
    const id = randomUUID();
    const now = new Date();
    const enabled = input.enabled ?? true;
    const secretRefs = input.secretRefs ?? [];
    const result = await pool.query<McpServerRow>(
      `insert into mcp_servers (
         id, owner_id, project_id, name, enabled,
         transport_config, secret_refs, created_at, updated_at
       ) values ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9)
       returning ${MCP_SERVER_COLUMNS}`,
      [
        id,
        ownerId,
        projectId,
        input.name,
        enabled,
        JSON.stringify(input.transportConfig),
        JSON.stringify(secretRefs),
        now,
        now,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error("MCP server insert returned no row");
    return mapRow(row);
  }

  async function getById(
    ownerId: string,
    projectId: string,
    serverId: string,
  ): Promise<McpServerConfig | null> {
    await ensureMcpServersTable(pool);
    const result = await pool.query<McpServerRow>(
      `select ${MCP_SERVER_COLUMNS}
         from mcp_servers
        where owner_id = $1
          and project_id = $2
          and id = $3
        limit 1`,
      [ownerId, projectId, serverId],
    );
    const row = result.rows[0];
    return row ? mapRow(row) : null;
  }

  async function listByProject(
    ownerId: string,
    projectId: string,
  ): Promise<McpServerConfig[]> {
    await ensureMcpServersTable(pool);
    const result = await pool.query<McpServerRow>(
      `select ${MCP_SERVER_COLUMNS}
         from mcp_servers
        where owner_id = $1
          and project_id = $2
        order by name, id`,
      [ownerId, projectId],
    );
    return result.rows.map(mapRow);
  }

  async function update(
    ownerId: string,
    projectId: string,
    serverId: string,
    input: UpdateMcpServerRequest,
  ): Promise<McpServerConfig | null> {
    await ensureMcpServersTable(pool);
    const existing = await getById(ownerId, projectId, serverId);
    if (!existing) return null;
    const name = input.name ?? existing.name;
    const enabled = input.enabled ?? existing.enabled;
    const transportConfig = input.transportConfig ?? existing.transportConfig;
    const secretRefs = input.secretRefs ?? existing.secretRefs;
    const result = await pool.query<McpServerRow>(
      `update mcp_servers
          set name = $4,
              enabled = $5,
              transport_config = $6::jsonb,
              secret_refs = $7::jsonb,
              updated_at = now()
        where owner_id = $1
          and project_id = $2
          and id = $3
      returning ${MCP_SERVER_COLUMNS}`,
      [
        ownerId,
        projectId,
        serverId,
        name,
        enabled,
        JSON.stringify(transportConfig),
        JSON.stringify(secretRefs),
      ],
    );
    const row = result.rows[0];
    return row ? mapRow(row) : null;
  }

  async function remove(
    ownerId: string,
    projectId: string,
    serverId: string,
  ): Promise<boolean> {
    await ensureMcpServersTable(pool);
    const result = await pool.query(
      `delete from mcp_servers
        where owner_id = $1
          and project_id = $2
          and id = $3`,
      [ownerId, projectId, serverId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  return {
    create,
    getById,
    listByProject,
    update,
    remove,
    delete: remove,
  };
}
