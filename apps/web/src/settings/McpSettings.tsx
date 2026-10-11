import { useEffect, useState, type FormEvent } from "react";
import type {
  CreateMcpServerRequest,
  McpServerConfig,
  ToolDescriptor,
} from "@uw/contracts";
import { api } from "../api/client";

export interface McpSettingsClient {
  listMcpServers(projectId: string): Promise<McpServerConfig[]>;
  createMcpServer(
    projectId: string,
    input: CreateMcpServerRequest,
  ): Promise<McpServerConfig>;
  updateMcpServer(
    projectId: string,
    serverId: string,
    input: Partial<CreateMcpServerRequest> & { enabled?: boolean },
  ): Promise<McpServerConfig>;
  deleteMcpServer(projectId: string, serverId: string): Promise<void>;
  syncMcpServer(
    projectId: string,
    serverId: string,
  ): Promise<{ server: McpServerConfig; tools: ToolDescriptor[] }>;
}

interface McpSettingsProps {
  projectId?: string;
  client?: McpSettingsClient;
}

function transportLabel(server: McpServerConfig): string {
  return server.transportConfig.transport;
}

function toSecretRefs(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function McpSettings({ projectId, client }: McpSettingsProps) {
  const activeClient: McpSettingsClient = client ?? api;
  const [projectInput, setProjectInput] = useState(projectId ?? "");
  const effectiveProjectId = (projectId ?? projectInput).trim();
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"stdio" | "sse">("stdio");
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  const [url, setUrl] = useState("");
  const [secretRefsText, setSecretRefsText] = useState("");
  const [saving, setSaving] = useState(false);

  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [discovered, setDiscovered] = useState<
    Record<string, ToolDescriptor[]>
  >({});
  const [syncError, setSyncError] = useState<string | null>(null);

  useEffect(() => {
    if (projectId !== undefined && projectId !== projectInput) {
      setProjectInput(projectId);
    }
  }, [projectId, projectInput]);

  useEffect(() => {
    let cancelled = false;
    if (!effectiveProjectId) {
      setServers([]);
      return;
    }
    setLoading(true);
    setError(null);
    void activeClient
      .listMcpServers(effectiveProjectId)
      .then((items) => {
        if (!cancelled) setServers(items);
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(
            cause instanceof Error ? cause.message : "Unable to load servers",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveProjectId]);

  async function addServer(event: FormEvent) {
    event.preventDefault();
    if (!effectiveProjectId) {
      setError("Enter a project ID first");
      return;
    }
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Server name is required");
      return;
    }
    const secretRefs = toSecretRefs(secretRefsText);
    let input: CreateMcpServerRequest;
    if (transport === "stdio") {
      const trimmedCommand = command.trim();
      if (!trimmedCommand) {
        setError("Command is required for stdio servers");
        return;
      }
      const args = argsText
        .split(/[\s,]+/)
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
      input = {
        name: trimmedName,
        transportConfig: {
          transport: "stdio",
          command: trimmedCommand,
          args,
          env: {},
        },
        secretRefs,
      };
    } else {
      const trimmedUrl = url.trim();
      if (!trimmedUrl) {
        setError("URL is required for SSE servers");
        return;
      }
      input = {
        name: trimmedName,
        transportConfig: {
          transport: "sse",
          url: trimmedUrl,
          headers: {},
        },
        secretRefs,
      };
    }
    setSaving(true);
    setError(null);
    try {
      const created = await activeClient.createMcpServer(
        effectiveProjectId,
        input,
      );
      setServers((current) => [...current, created]);
      setName("");
      setCommand("");
      setArgsText("");
      setUrl("");
      setSecretRefsText("");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to create server",
      );
    } finally {
      setSaving(false);
    }
  }

  async function removeServer(server: McpServerConfig) {
    setError(null);
    try {
      await activeClient.deleteMcpServer(effectiveProjectId, server.id);
      setServers((current) => current.filter((item) => item.id !== server.id));
      setDiscovered((current) => {
        const next = { ...current };
        delete next[server.id];
        return next;
      });
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to delete server",
      );
    }
  }

  async function syncServer(server: McpServerConfig) {
    setSyncingId(server.id);
    setSyncError(null);
    try {
      const result = await activeClient.syncMcpServer(
        effectiveProjectId,
        server.id,
      );
      setDiscovered((current) => ({
        ...current,
        [server.id]: result.tools,
      }));
    } catch (cause) {
      setSyncError(cause instanceof Error ? cause.message : "Sync failed");
    } finally {
      setSyncingId(null);
    }
  }

  return (
    <section aria-labelledby="mcp-servers-title">
      <h2 id="mcp-servers-title">MCP Servers</h2>
      <p>
        Configure Model Context Protocol servers. Sync discovers tools as{" "}
        <code>mcp.&lt;server&gt;.&lt;tool&gt;@1.0.0</code> for ReAct agents.
      </p>
      {projectId === undefined ? (
        <label>
          Project ID
          <input
            aria-label="Project ID"
            value={projectInput}
            onChange={(event) => setProjectInput(event.target.value)}
            placeholder="project-uuid"
          />
        </label>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {loading ? <p>Loading MCP servers…</p> : null}
      {!loading && servers.length === 0 && effectiveProjectId ? (
        <p>No MCP servers configured.</p>
      ) : null}
      {servers.length > 0 ? (
        <ul aria-label="Configured MCP servers">
          {servers.map((server) => (
            <li key={server.id}>
              <span>{server.name}</span>{" "}
              <span aria-label={`Status ${server.name}`}>
                {server.enabled ? "Enabled" : "Disabled"}
              </span>{" "}
              <span aria-label={`Transport ${server.name}`}>
                {transportLabel(server)}
              </span>{" "}
              <button
                type="button"
                aria-label={`Sync ${server.name}`}
                disabled={syncingId === server.id}
                onClick={() => void syncServer(server)}
              >
                {syncingId === server.id
                  ? "Syncing…"
                  : "Sync / Test Connection"}
              </button>{" "}
              <button
                type="button"
                aria-label={`Delete ${server.name}`}
                onClick={() => void removeServer(server)}
              >
                Delete
              </button>
              {discovered[server.id] ? (
                <ul aria-label={`Discovered tools for ${server.name}`}>
                  {discovered[server.id]!.map((tool) => (
                    <li key={`${tool.id}@${tool.version}`}>
                      {tool.id}@{tool.version} — {tool.name}
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {syncError ? <p role="alert">{syncError}</p> : null}

      <form
        aria-label="MCP server form"
        onSubmit={(event) => void addServer(event)}
      >
        <h3>Add MCP server</h3>
        <label>
          Server name
          <input
            aria-label="Server name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="local-search"
          />
        </label>
        <label>
          Transport
          <select
            aria-label="Transport"
            value={transport}
            onChange={(event) =>
              setTransport(event.target.value === "sse" ? "sse" : "stdio")
            }
          >
            <option value="stdio">stdio</option>
            <option value="sse">sse</option>
          </select>
        </label>
        {transport === "stdio" ? (
          <>
            <label>
              Command
              <input
                aria-label="Command"
                value={command}
                onChange={(event) => setCommand(event.target.value)}
                placeholder="npx"
              />
            </label>
            <label>
              Args (space or comma separated)
              <input
                aria-label="Args"
                value={argsText}
                onChange={(event) => setArgsText(event.target.value)}
                placeholder="-y mcp-server"
              />
            </label>
          </>
        ) : (
          <label>
            Server URL
            <input
              aria-label="Server URL"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://example.com/mcp/sse"
            />
          </label>
        )}
        <label>
          Secret refs (comma separated)
          <input
            aria-label="Secret refs"
            value={secretRefsText}
            onChange={(event) => setSecretRefsText(event.target.value)}
            placeholder="secret://vault/api-key"
          />
        </label>
        <button type="submit" disabled={saving}>
          {saving ? "Adding…" : "Add server"}
        </button>
      </form>
    </section>
  );
}
