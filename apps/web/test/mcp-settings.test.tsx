import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServerConfig, ToolDescriptor } from "@uw/contracts";
import { McpSettings } from "../src/settings/McpSettings";
import { AgentStepEditor } from "../src/workflows/AgentStepEditor";

const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

function stdioServer(
  overrides: Partial<McpServerConfig> = {},
): McpServerConfig {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    projectId: PROJECT_ID,
    name: "local-search",
    enabled: true,
    transportConfig: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "mcp-server"],
      env: {},
    },
    secretRefs: [],
    ...overrides,
  } as McpServerConfig;
}

function mcpTool(): ToolDescriptor {
  return {
    id: "mcp.local-search.search",
    version: "1.0.0",
    name: "Search",
    description: "search the web",
    accepts: ["text"],
    produces: ["text"],
    permissions: [],
    capabilities: [],
    executionMode: "server",
    idempotency: "safe",
    configSchema: { type: "object" },
    requiresApproval: false,
  } as unknown as ToolDescriptor;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("McpSettings", () => {
  it("renders the configured server list", async () => {
    const client = {
      listMcpServers: vi.fn().mockResolvedValue([stdioServer()]),
      createMcpServer: vi.fn(),
      updateMcpServer: vi.fn(),
      deleteMcpServer: vi.fn(),
      syncMcpServer: vi.fn(),
    };
    render(<McpSettings projectId={PROJECT_ID} client={client} />);

    expect(
      await screen.findByRole("heading", { name: /mcp servers/i }),
    ).toBeInTheDocument();
    expect(await screen.findByText("local-search")).toBeInTheDocument();
    expect(client.listMcpServers).toHaveBeenCalledWith(PROJECT_ID);
  });

  it("adds a new MCP server from the form", async () => {
    const created = stdioServer({
      id: "22222222-2222-4222-8222-222222222223",
      name: "new-server",
    });
    const client = {
      listMcpServers: vi.fn().mockResolvedValue([]),
      createMcpServer: vi.fn().mockResolvedValue(created),
      updateMcpServer: vi.fn(),
      deleteMcpServer: vi.fn(),
      syncMcpServer: vi.fn(),
    };
    render(<McpSettings projectId={PROJECT_ID} client={client} />);

    await screen.findByRole("heading", { name: /mcp servers/i });
    fireEvent.change(screen.getByLabelText(/server name/i), {
      target: { value: "new-server" },
    });
    fireEvent.change(screen.getByLabelText(/^command/i), {
      target: { value: "npx" },
    });
    fireEvent.click(screen.getByRole("button", { name: /add server/i }));

    await waitFor(() =>
      expect(client.createMcpServer).toHaveBeenCalledWith(
        PROJECT_ID,
        expect.objectContaining({
          name: "new-server",
          transportConfig: expect.objectContaining({ transport: "stdio" }),
        }),
      ),
    );
    expect(await screen.findByText("new-server")).toBeInTheDocument();
  });

  it("syncs a server and displays discovered tools", async () => {
    const tool = mcpTool();
    const client = {
      listMcpServers: vi.fn().mockResolvedValue([stdioServer()]),
      createMcpServer: vi.fn(),
      updateMcpServer: vi.fn(),
      deleteMcpServer: vi.fn(),
      syncMcpServer: vi
        .fn()
        .mockResolvedValue({ server: stdioServer(), tools: [tool] }),
    };
    render(<McpSettings projectId={PROJECT_ID} client={client} />);

    const syncButton = await screen.findByRole("button", {
      name: /sync.*local-search|test connection/i,
    });
    fireEvent.click(syncButton);

    await waitFor(() =>
      expect(client.syncMcpServer).toHaveBeenCalledWith(
        PROJECT_ID,
        stdioServer().id,
      ),
    );
    expect(
      await screen.findByText(/mcp\.local-search\.search/i),
    ).toBeInTheDocument();
  });

  it("deletes an MCP server after confirmation", async () => {
    const client = {
      listMcpServers: vi.fn().mockResolvedValue([stdioServer()]),
      createMcpServer: vi.fn(),
      updateMcpServer: vi.fn(),
      deleteMcpServer: vi.fn().mockResolvedValue(undefined),
      syncMcpServer: vi.fn(),
    };
    render(<McpSettings projectId={PROJECT_ID} client={client} />);

    const deleteButton = await screen.findByRole("button", {
      name: /delete local-search/i,
    });
    fireEvent.click(deleteButton);

    await waitFor(() =>
      expect(client.deleteMcpServer).toHaveBeenCalledWith(
        PROJECT_ID,
        stdioServer().id,
      ),
    );
    await waitFor(() =>
      expect(screen.queryByText("local-search")).not.toBeInTheDocument(),
    );
  });
});

describe("AgentStepEditor MCP tools", () => {
  it("lists discovered MCP tools in the allowedTools checklist", async () => {
    const tool = mcpTool();
    const updateConfig = vi.fn();
    render(
      <AgentStepEditor
        config={{ allowedTools: [] }}
        updateConfig={updateConfig}
        availableTools={[tool]}
      />,
    );

    const list = screen.getByRole("group", { name: /allowed tools/i });
    expect(
      within(list).getByText(/mcp\.local-search\.search/i),
    ).toBeInTheDocument();

    fireEvent.click(
      within(list).getByRole("checkbox", {
        name: /mcp\.local-search\.search/i,
      }),
    );
    expect(updateConfig).toHaveBeenCalledWith({
      allowedTools: ["mcp.local-search.search@1.0.0"],
    });
  });
});
