import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/client";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("API client routing", () => {
  it("routes application API requests through the /api reverse-proxy prefix", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ initialized: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.setupStatus();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/setup/status",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("uses proxy-safe Phase 3 endpoints and never submits owner or permission grants", async () => {
    const fetchMock = vi.fn(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        const path = String(url);
        if (path === "/api/tools") {
          return new Response(
            JSON.stringify({
              tools: [
                {
                  id: "builtin.text.trim",
                  version: "1.0.0",
                  name: "Text Trim",
                  description: "Trim whitespace",
                  accepts: ["text"],
                  produces: ["text"],
                  permissions: [],
                  capabilities: ["transform"],
                  executionMode: "local",
                  idempotency: "safe",
                  configSchema: { type: "object" },
                },
              ],
              grantedPermissions: [],
            }),
            { status: 200 },
          );
        }
        if (path.endsWith("/executions") && init?.method === "POST") {
          return new Response(
            JSON.stringify({
              executionId: "44444444-4444-4444-8444-444444444444",
              traceId: "55555555-5555-4555-8555-555555555555",
              status: "queued",
            }),
            { status: 202 },
          );
        }
        throw new Error("Unexpected API request: " + path);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const catalog = await api.listTools();
    expect(catalog.tools).toHaveLength(1);
    expect(catalog.grantedPermissions).toEqual([]);
    const start = await api.runWorkflow(
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
      {
        id: "11111111-1111-4111-8111-111111111111",
        type: "text",
        schemaVersion: 1,
        mimeType: "text/plain",
        metadata: {},
        payload: "test",
        provenance: { sourceContextIds: [] },
        capabilities: [],
      },
    );
    expect(start.status).toBe("queued");
    const body = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(Object.keys(body)).toEqual(["input"]);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "/api/projects/22222222-2222-4222-8222-222222222222/workflows/33333333-3333-4333-8333-333333333333/executions",
    );
  });

  it("wraps non-JSON proxy errors as a structured ApiError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("<html>bad gateway</html>", {
          status: 502,
          headers: { "content-type": "text/html" },
        }),
      ),
    );

    await expect(api.setupStatus()).rejects.toMatchObject({
      name: "ApiError",
      status: 502,
      code: "REQUEST_FAILED",
      message: "Request failed",
    });
  });
});
