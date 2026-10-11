import { Router } from "express";
import type { OwnerPublic } from "@uw/contracts";
import {
  CreateMcpServerRequestSchema,
  IdSchema,
  UpdateMcpServerRequestSchema,
  type McpServerConfig,
} from "@uw/contracts";
import type { AuthService } from "@uw/auth";
import type { McpToolDefinition, ToolRegistry } from "@uw/tools";
import {
  McpClient,
  StdioProcessTransport,
  registerMcpTools,
  unregisterMcpServerTools,
} from "@uw/tools";
import type { McpServerRepository } from "@uw/database";
import { requireOwner, type SessionCookieConfig } from "../middleware/auth.js";
import {
  HttpError,
  mapDomainError,
  parseRequest,
} from "../middleware/validate.js";

export type McpDiscoverTools = (
  server: McpServerConfig,
) => Promise<McpToolDefinition[]>;

export interface McpRouterDependencies {
  authService: AuthService;
  sessionCookie: SessionCookieConfig;
  mcpServers: McpServerRepository;
  registry: ToolRegistry;
  discoverTools?: McpDiscoverTools;
}

function ownerFromLocals(locals: Record<string, unknown>): OwnerPublic {
  return locals.owner as OwnerPublic;
}

function stubExecutorClient() {
  return {
    async callTool(name: string, args: Record<string, unknown>) {
      void name;
      return { content: [{ type: "text", text: JSON.stringify(args) }] };
    },
  };
}

async function defaultDiscoverTools(
  server: McpServerConfig,
): Promise<McpToolDefinition[]> {
  const transport = server.transportConfig;
  if (transport.transport !== "stdio") {
    throw new HttpError(
      502,
      "SYNC_FAILED",
      "Only stdio MCP servers can be synced",
    );
  }
  const rawEnv =
    typeof transport.env === "object" && transport.env !== null
      ? (transport.env as Record<string, string>)
      : {};
  const plainEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawEnv)) {
    if (typeof value === "string" && !value.trim().startsWith("secret://")) {
      plainEnv[key] = value;
    }
  }
  const mcpTransport = new StdioProcessTransport({
    command: transport.command,
    args: transport.args ?? [],
    env: plainEnv,
  });
  const client = new McpClient(mcpTransport);
  try {
    await client.connect();
    return await client.listTools();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(
      502,
      "SYNC_FAILED",
      error instanceof Error && error.message
        ? error.message
        : "MCP sync failed",
    );
  } finally {
    await client.close().catch(() => {});
  }
}

export function createMcpRouter(deps: McpRouterDependencies) {
  const router = Router({ mergeParams: true });
  router.use(requireOwner(deps.authService, deps.sessionCookie));
  const discover = deps.discoverTools ?? defaultDiscoverTools;

  function projectIdOf(params: unknown): string {
    return parseRequest(
      IdSchema,
      (params as Record<string, unknown>).projectId,
    );
  }

  function serverIdOf(params: unknown): string {
    return parseRequest(IdSchema, (params as Record<string, unknown>).serverId);
  }

  router.get("/", async (req, res, next) => {
    try {
      const owner = ownerFromLocals(res.locals);
      const projectId = projectIdOf(req.params);
      const servers = await deps.mcpServers.listByProject(owner.id, projectId);
      res.json({ servers });
    } catch (error) {
      next(mapDomainError(error));
    }
  });

  router.post("/", async (req, res, next) => {
    try {
      const owner = ownerFromLocals(res.locals);
      const projectId = projectIdOf(req.params);
      const input = parseRequest(CreateMcpServerRequestSchema, req.body);
      const server = await deps.mcpServers.create(owner.id, projectId, {
        ...input,
        projectId,
      });
      res.status(201).json({ server });
    } catch (error) {
      next(mapDomainError(error));
    }
  });

  router.get("/:serverId", async (req, res, next) => {
    try {
      const owner = ownerFromLocals(res.locals);
      const projectId = projectIdOf(req.params);
      const serverId = serverIdOf(req.params);
      const server = await deps.mcpServers.getById(
        owner.id,
        projectId,
        serverId,
      );
      if (!server) {
        throw new HttpError(404, "NOT_FOUND", "MCP server not found");
      }
      res.json({ server });
    } catch (error) {
      next(mapDomainError(error));
    }
  });

  router.patch("/:serverId", async (req, res, next) => {
    try {
      const owner = ownerFromLocals(res.locals);
      const projectId = projectIdOf(req.params);
      const serverId = serverIdOf(req.params);
      const input = parseRequest(UpdateMcpServerRequestSchema, req.body);
      const server = await deps.mcpServers.update(
        owner.id,
        projectId,
        serverId,
        input,
      );
      if (!server) {
        throw new HttpError(404, "NOT_FOUND", "MCP server not found");
      }
      res.json({ server });
    } catch (error) {
      next(mapDomainError(error));
    }
  });

  router.delete("/:serverId", async (req, res, next) => {
    try {
      const owner = ownerFromLocals(res.locals);
      const projectId = projectIdOf(req.params);
      const serverId = serverIdOf(req.params);
      const existing = await deps.mcpServers.getById(
        owner.id,
        projectId,
        serverId,
      );
      if (!existing) {
        throw new HttpError(404, "NOT_FOUND", "MCP server not found");
      }
      await deps.mcpServers.remove(owner.id, projectId, serverId);
      try {
        unregisterMcpServerTools(deps.registry, serverId);
      } catch {
        // Registry unregister is best-effort; persistence already removed.
      }
      res.json({ deleted: true });
    } catch (error) {
      next(mapDomainError(error));
    }
  });

  router.post("/:serverId/sync", async (req, res, next) => {
    try {
      const owner = ownerFromLocals(res.locals);
      const projectId = projectIdOf(req.params);
      const serverId = serverIdOf(req.params);
      const server = await deps.mcpServers.getById(
        owner.id,
        projectId,
        serverId,
      );
      if (!server) {
        throw new HttpError(404, "NOT_FOUND", "MCP server not found");
      }
      let mcpTools: McpToolDefinition[];
      try {
        mcpTools = await discover(server);
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(
          502,
          "SYNC_FAILED",
          error instanceof Error && error.message
            ? error.message
            : "MCP sync failed",
        );
      }
      try {
        unregisterMcpServerTools(deps.registry, server.id);
      } catch {
        // Ignore missing tools on first sync.
      }
      const tools = registerMcpTools(
        deps.registry,
        server.id,
        mcpTools,
        stubExecutorClient(),
      );
      res.json({ server, tools });
    } catch (error) {
      next(mapDomainError(error));
    }
  });

  return router;
}
