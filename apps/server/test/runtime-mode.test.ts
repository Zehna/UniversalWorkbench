import { describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "../src/config.js";
import {
  startRuntime,
  type RuntimeComposition,
  type RuntimeAdapters,
} from "../src/runtime.js";

function config(appMode: ServerConfig["appMode"]): ServerConfig {
  return {
    databaseUrl: "postgresql://u:p@localhost:5432/db",
    port: 3000,
    appMode,
    sessionCookieName: "uw_session",
    sessionCookieSecure: false,
    sessionTtlSeconds: 604800,
    artifactsDir: "./data/artifacts",
    trustedOrigins: ["http://localhost:8080"],
  };
}

function setup(mode: ServerConfig["appMode"]) {
  const worker = {
    start: vi.fn(),
    stop: vi.fn(async () => undefined),
  };
  const close = vi.fn(async () => undefined);
  const composition = {
    app: (() => undefined) as never,
    authService: {} as never,
    syncService: {} as never,
    worker: worker as never,
    close,
  } satisfies RuntimeComposition;

  const httpServer = {
    listen: vi.fn(),
    close: vi.fn((callback: (error?: Error) => void) => callback()),
  };
  const websocketServer = {
    clients: new Set<{ terminate(): void }>(),
    close: vi.fn((callback: (error?: Error) => void) => callback()),
  };
  const adapters = {
    createHttpServer: vi.fn(() => httpServer as never),
    attachSyncWebSocket: vi.fn(() => websocketServer as never),
  } satisfies RuntimeAdapters;

  return {
    runtime: startRuntime(config(mode), composition, adapters),
    worker,
    close,
    adapters,
    httpServer,
  };
}

describe("Phase 3 runtime modes", () => {
  it("worker mode starts the worker without opening an HTTP listener", async () => {
    const { runtime, worker, adapters, close } = setup("worker");

    expect(worker.start).toHaveBeenCalledTimes(1);
    expect(adapters.createHttpServer).not.toHaveBeenCalled();
    expect(adapters.attachSyncWebSocket).not.toHaveBeenCalled();

    await runtime.stop();
    expect(worker.stop).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("api mode opens HTTP/WebSocket without starting the worker", async () => {
    const { runtime, worker, adapters, httpServer } = setup("api");

    expect(worker.start).not.toHaveBeenCalled();
    expect(adapters.createHttpServer).toHaveBeenCalledTimes(1);
    expect(adapters.attachSyncWebSocket).toHaveBeenCalledTimes(1);
    expect(httpServer.listen).toHaveBeenCalledWith(
      3000,
      "0.0.0.0",
      expect.any(Function),
    );

    await runtime.stop();
  });

  it("all mode starts HTTP/WebSocket and the execution worker", async () => {
    const { runtime, worker, adapters } = setup("all");

    expect(worker.start).toHaveBeenCalledTimes(1);
    expect(adapters.createHttpServer).toHaveBeenCalledTimes(1);
    expect(adapters.attachSyncWebSocket).toHaveBeenCalledTimes(1);

    await runtime.stop();
  });

  it("stops the worker before closing composed resources", async () => {
    const events: string[] = [];
    const worker = {
      start() {},
      async stop() {
        events.push("worker");
      },
    };
    const composition = {
      app: (() => undefined) as never,
      authService: {} as never,
      syncService: {} as never,
      worker: worker as never,
      async close() {
        events.push("close");
      },
    } satisfies RuntimeComposition;
    const adapters = {
      createHttpServer: vi.fn(() => ({
        listen() {},
        close(callback: (error?: Error) => void) {
          events.push("http");
          callback();
        },
      }) as never),
      attachSyncWebSocket: vi.fn(() => ({
        clients: new Set(),
        close(callback: (error?: Error) => void) {
          events.push("ws");
          callback();
        },
      }) as never),
    } satisfies RuntimeAdapters;

    const runtime = startRuntime(config("all"), composition, adapters);
    await runtime.stop();

    expect(events[0]).toBe("worker");
    expect(events.at(-1)).toBe("close");
  });
});
