import { spawn, type ChildProcess } from "node:child_process";
import { ToolRuntimeError } from "../errors.js";

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  title?: string;
}

export interface McpContentItem {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface McpCallToolResult {
  content?: McpContentItem[];
  structuredContent?: unknown;
  isError?: boolean;
}

export interface McpTransport {
  connect(): Promise<void>;
  listTools(): Promise<McpToolDefinition[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<McpCallToolResult>;
  close(): Promise<void>;
}

export interface McpClientOptions {
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

function isToolRuntimeError(error: unknown): error is ToolRuntimeError {
  return error instanceof ToolRuntimeError;
}

async function withTimeout<T>(
  task: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  if (timeoutMs <= 0) return task;
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new ToolRuntimeError("TIMEOUT", message));
      }, timeoutMs);
      timer.unref?.();
    });
    return await Promise.race([task, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function toRuntimeError(
  error: unknown,
  fallbackMessage: string,
): ToolRuntimeError {
  if (isToolRuntimeError(error)) return error;
  if (error instanceof Error && error.message.includes("timed out")) {
    return new ToolRuntimeError("TIMEOUT", error.message);
  }
  const message =
    error instanceof Error && error.message ? error.message : fallbackMessage;
  // Avoid leaking transport internals; keep the message but classify safely.
  return new ToolRuntimeError("NETWORK_FAILURE", message);
}

function assertToolList(value: unknown): McpToolDefinition[] {
  if (!Array.isArray(value)) {
    throw new ToolRuntimeError(
      "INVALID_OUTPUT",
      "MCP transport returned malformed tools",
    );
  }
  for (const entry of value) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof (entry as McpToolDefinition).name !== "string" ||
      (entry as McpToolDefinition).name.trim().length === 0
    ) {
      throw new ToolRuntimeError(
        "INVALID_OUTPUT",
        "MCP transport returned malformed tools",
      );
    }
  }
  return value as McpToolDefinition[];
}

export class McpClient {
  private connected = false;
  private readonly timeoutMs: number;

  constructor(
    private readonly transport: McpTransport,
    options: McpClientOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<void> {
    try {
      await withTimeout(
        this.transport.connect(),
        this.timeoutMs,
        "MCP connection timed out",
      );
      this.connected = true;
    } catch (error) {
      this.connected = false;
      throw toRuntimeError(error, "MCP connection failed");
    }
  }

  async listTools(): Promise<McpToolDefinition[]> {
    this.assertConnected();
    try {
      const tools = await withTimeout(
        this.transport.listTools(),
        this.timeoutMs,
        "MCP listTools timed out",
      );
      return assertToolList(tools);
    } catch (error) {
      throw toRuntimeError(error, "MCP listTools failed");
    }
  }

  async callTool(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<McpCallToolResult> {
    this.assertConnected();
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new ToolRuntimeError("INVALID_INPUT", "MCP tool name is invalid");
    }
    if (typeof args !== "object" || args === null || Array.isArray(args)) {
      throw new ToolRuntimeError(
        "INVALID_INPUT",
        "MCP tool arguments must be an object",
      );
    }
    try {
      const result = await withTimeout(
        this.transport.callTool(name, args),
        this.timeoutMs,
        `MCP callTool ${name} timed out`,
      );
      if (typeof result !== "object" || result === null) {
        throw new ToolRuntimeError(
          "INVALID_OUTPUT",
          "MCP transport returned a malformed result",
        );
      }
      return result;
    } catch (error) {
      throw toRuntimeError(error, `MCP callTool ${name} failed`);
    }
  }

  async close(): Promise<void> {
    try {
      await this.transport.close();
    } catch (error) {
      throw toRuntimeError(error, "MCP close failed");
    } finally {
      this.connected = false;
    }
  }

  private assertConnected(): void {
    if (!this.connected) {
      throw new ToolRuntimeError(
        "NETWORK_FAILURE",
        "MCP client is not connected",
      );
    }
  }
}

export class InMemoryMcpTransport implements McpTransport {
  private connected = false;

  constructor(
    private tools: McpToolDefinition[] = [],
    private results: Record<string, McpCallToolResult> = {},
    private readonly delayMs = 0,
  ) {}

  setTools(tools: McpToolDefinition[]): void {
    this.tools = tools;
  }

  setResult(toolName: string, result: McpCallToolResult): void {
    this.results[toolName] = result;
  }

  async connect(): Promise<void> {
    await this.delay();
    this.connected = true;
  }

  async listTools(): Promise<McpToolDefinition[]> {
    this.assertConnected();
    await this.delay();
    return this.tools.map((tool) => ({ ...tool }));
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<McpCallToolResult> {
    this.assertConnected();
    await this.delay();
    const preset = this.results[name];
    if (preset !== undefined) {
      return structuredCloneSafe(preset);
    }
    return { content: [{ type: "text", text: JSON.stringify(args) }] };
  }

  async close(): Promise<void> {
    await this.delay();
    this.connected = false;
  }

  private assertConnected(): void {
    if (!this.connected) {
      throw new Error("InMemoryMcpTransport is not connected");
    }
  }

  private async delay(): Promise<void> {
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
  }
}

function structuredCloneSafe<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as T;
  }
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string };
}

export interface StdioProcessTransportOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * Real process transport speaking newline-delimited JSON-RPC 2.0 over stdio.
 * Implements the same McpTransport surface as the in-memory mock so clients
 * and tests can swap implementations.
 */
export class StdioProcessTransport implements McpTransport {
  private child: ChildProcess | undefined;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();
  private buffer = "";
  private readonly timeoutMs: number;

  constructor(private readonly options: StdioProcessTransportOptions) {
    if (!options.command || options.command.trim().length === 0) {
      throw new Error("StdioProcessTransport requires a command");
    }
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async connect(): Promise<void> {
    if (this.child) return;
    await new Promise<void>((resolve, reject) => {
      try {
        this.child = spawn(this.options.command, this.options.args ?? [], {
          env: { ...process.env, ...(this.options.env ?? {}) },
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (error) {
        reject(
          error instanceof Error ? error : new Error("Failed to spawn MCP"),
        );
        return;
      }
      const child = this.child!;
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const onSpawn = (): void => {
        cleanup();
        child.stdout?.on("data", (chunk) => this.onData(chunk));
        child.stderr?.on("data", () => {});
        resolve();
      };
      const cleanup = (): void => {
        child.off("error", onError);
        child.off("spawn", onSpawn);
      };
      child.once("error", onError);
      child.once("spawn", onSpawn);
    });
  }

  async listTools(): Promise<McpToolDefinition[]> {
    const result = (await this.send("tools/list", {})) as {
      tools?: unknown;
    };
    return assertToolList(result?.tools ?? []);
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<McpCallToolResult> {
    const result = (await this.send("tools/call", {
      name,
      arguments: args,
    })) as McpCallToolResult;
    if (typeof result !== "object" || result === null) {
      throw new Error("MCP server returned a malformed tools/call result");
    }
    return result;
  }

  async close(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    for (const [, pending] of this.pending) {
      pending.reject(new Error("MCP transport closed"));
    }
    this.pending.clear();
    if (!child) return;
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill();
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already exited.
        }
        resolve();
      }, 1_000).unref?.();
    });
  }

  private send(method: string, params: unknown): Promise<unknown> {
    const child = this.child;
    if (!child?.stdin?.writable) {
      return Promise.reject(new Error("MCP transport is not connected"));
    }
    const id = this.nextId++;
    const request: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`MCP request ${method} timed out`));
        }
      }, this.timeoutMs);
      timer.unref?.();
      const wrappedResolve = (value: unknown): void => {
        clearTimeout(timer);
        resolve(value);
      };
      const wrappedReject = (error: Error): void => {
        clearTimeout(timer);
        reject(error);
      };
      this.pending.set(id, {
        resolve: wrappedResolve,
        reject: wrappedReject,
      });
      try {
        child.stdin!.write(`${JSON.stringify(request)}\n`);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error("MCP write failed"));
      }
    });
  }

  private onData(chunk: Uint8Array | string): void {
    this.buffer +=
      typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length > 0) this.onLine(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private onLine(line: string): void {
    let parsed: JsonRpcResponse;
    try {
      parsed = JSON.parse(line) as JsonRpcResponse;
    } catch {
      return;
    }
    if (typeof parsed.id !== "number") return;
    const pending = this.pending.get(parsed.id);
    if (!pending) return;
    this.pending.delete(parsed.id);
    if (parsed.error) {
      pending.reject(new Error(parsed.error.message ?? "MCP request failed"));
      return;
    }
    pending.resolve(parsed.result);
  }
}
