import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { ContextEnvelope } from "@uw/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyHttpIdempotency,
  createEgressPolicy,
  createHttpTool,
  runTool,
  type EgressPolicy,
  type HttpTransport,
  type HttpTransportResponse,
  type ToolRunContext,
} from "../src/index.js";

const input: ContextEnvelope = {
  id: "11111111-1111-4111-8111-111111111111",
  type: "json",
  schemaVersion: 1,
  mimeType: "application/json",
  metadata: {},
  payload: { example: true },
  provenance: { sourceContextIds: [] },
  capabilities: [],
};

const baseContext: ToolRunContext = {
  executionId: "22222222-2222-4222-8222-222222222222",
  stepId: "33333333-3333-4333-8333-333333333333",
  projectId: "44444444-4444-4444-8444-444444444444",
  traceId: "55555555-5555-4555-8555-555555555555",
  signal: new AbortController().signal,
  permissions: new Set(["network"]),
};

const policy = createEgressPolicy({ resolver: async () => ["93.184.216.34"] });

function response(
  status = 200,
  headers: HttpTransportResponse["headers"] = {},
  body = '{"ok":true}',
): HttpTransportResponse {
  return { status, headers, body: new TextEncoder().encode(body) };
}

describe("safe HTTP tool", () => {
  it("pins the validated DNS address and excludes cookies from response", async () => {
    const request = vi.fn<HttpTransport["request"]>(async () =>
      response(200, {
        "content-type": "application/json",
        "set-cookie": "session=secret",
        "x-private-header": "secret",
      }),
    );
    const result = await runTool(
      createHttpTool({ policy, transport: { request } }),
      input,
      { method: "GET", url: "https://public.example.net/" },
      baseContext,
    );
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[1]).toBe("93.184.216.34");
    expect(result.outputs[0]).toMatchObject({
      type: "api_response",
      capabilities: [],
      payload: {
        status: 200,
        headers: { "content-type": "application/json" },
        body: '{"ok":true}',
      },
    });
    expect(JSON.stringify(result)).not.toContain("session=secret");
  });

  it("validates each redirect before sending another request", async () => {
    const request = vi.fn<HttpTransport["request"]>(async () =>
      response(
        302,
        { location: "http://169.254.169.254/latest/meta-data/" },
        "",
      ),
    );
    await expect(
      runTool(
        createHttpTool({ policy, transport: { request } }),
        input,
        { method: "GET", url: "https://public.example.net/" },
        baseContext,
      ),
    ).rejects.toMatchObject({ code: "EGRESS_BLOCKED" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("never forwards bearer tokens after a redirect", async () => {
    const calls: Array<Record<string, string>> = [];
    const request: HttpTransport["request"] = async (
      _url,
      _address,
      options,
    ) => {
      calls.push({ ...options.headers });
      return calls.length === 1
        ? response(302, { location: "https://other.example.net/next" }, "")
        : response();
    };
    await runTool(
      createHttpTool({ policy, transport: { request } }),
      input,
      {
        method: "GET",
        url: "https://public.example.net/",
        headers: { Authorization: "Bearer private" },
      },
      baseContext,
    );
    expect(calls[0]?.authorization).toBe("Bearer private");
    expect(calls[1]?.authorization).toBeUndefined();
  });

  it("rejects a redirect from HTTPS to HTTP", async () => {
    const request = vi.fn<HttpTransport["request"]>(async () =>
      response(301, { location: "http://public.example.net/next" }, ""),
    );
    await expect(
      runTool(
        createHttpTool({ policy, transport: { request } }),
        input,
        { method: "GET", url: "https://public.example.net/" },
        baseContext,
      ),
    ).rejects.toMatchObject({ code: "EGRESS_BLOCKED" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("classifies methods and requires a workflow-issued idempotency key for mutations", async () => {
    expect(classifyHttpIdempotency("GET")).toBe("safe");
    expect(classifyHttpIdempotency("HEAD")).toBe("safe");
    expect(classifyHttpIdempotency("POST")).toBe("unsafe");
    expect(classifyHttpIdempotency("POST", "op-123")).toBe("keyed");
    const request = vi.fn<HttpTransport["request"]>(async () => response());
    const tool = createHttpTool({ policy, transport: { request } });
    await expect(
      runTool(
        tool,
        input,
        { method: "POST", url: "https://public.example.net/" },
        baseContext,
      ),
    ).rejects.toMatchObject({ code: "INVALID_CONFIG" });
    await runTool(
      tool,
      input,
      { method: "POST", url: "https://public.example.net/", body: "hello" },
      { ...baseContext, idempotencyKey: "op-123" },
    );
    expect(request.mock.calls[0]?.[2].headers["idempotency-key"]).toBe(
      "op-123",
    );
  });

  it("rejects forbidden request headers and disallowed input types", async () => {
    const request = vi.fn<HttpTransport["request"]>(async () => response());
    const tool = createHttpTool({ policy, transport: { request } });
    await expect(
      runTool(
        tool,
        input,
        {
          method: "GET",
          url: "https://public.example.net/",
          headers: { Cookie: "private" },
        },
        baseContext,
      ),
    ).rejects.toMatchObject({ code: "INVALID_CONFIG" });
    await expect(
      runTool(
        tool,
        { ...input, type: "artifact_ref" },
        { method: "GET", url: "https://public.example.net/" },
        baseContext,
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(request).not.toHaveBeenCalled();
  });

  it("aborts an unresponsive transport when the timeout elapses", async () => {
    const request: HttpTransport["request"] = async (_url, _address, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener(
          "abort",
          () => reject(new Error("private key in transport")),
          {
            once: true,
          },
        );
      });
    await expect(
      runTool(
        createHttpTool({ policy, transport: { request } }),
        input,
        { method: "GET", url: "https://public.example.net/", timeoutMs: 20 },
        baseContext,
      ),
    ).rejects.toMatchObject({
      code: "TIMEOUT",
      message: "HTTP request timed out",
    });
  });

  it("rejects oversized transport responses without returning partial data", async () => {
    const request: HttpTransport["request"] = async () =>
      response(200, {}, "123456789");
    await expect(
      runTool(
        createHttpTool({ policy, transport: { request } }),
        input,
        {
          method: "GET",
          url: "https://public.example.net/",
          maxResponseBytes: 5,
        },
        baseContext,
      ),
    ).rejects.toMatchObject({ code: "INVALID_OUTPUT" });
  });

  it("uses the pinned IP for native transport, retaining original Host header", async () => {
    const server = createServer((req, res) => {
      res.setHeader("content-type", "text/plain");
      res.setHeader("set-cookie", "secret=true");
      res.end(req.headers.host ?? "");
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const port = (server.address() as AddressInfo).port;
      const fakePolicy: EgressPolicy = {
        assertAllowed: async () => {},
        resolveAllowed: async () => ["127.0.0.1"],
      };
      const result = await runTool(
        createHttpTool({ policy: fakePolicy }),
        input,
        { method: "GET", url: "http://public.example.net:" + port + "/" },
        baseContext,
      );
      expect(result.outputs[0]?.payload).toMatchObject({
        status: 200,
        body: "public.example.net:" + port,
        headers: { "content-type": "text/plain" },
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("stops reading a streamed response once the native byte limit is exceeded", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("1234");
      res.end("56789");
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const port = (server.address() as AddressInfo).port;
      const fakePolicy: EgressPolicy = {
        assertAllowed: async () => {},
        resolveAllowed: async () => ["127.0.0.1"],
      };
      await expect(
        runTool(
          createHttpTool({ policy: fakePolicy }),
          input,
          {
            method: "GET",
            url: "http://public.example.net:" + port,
            maxResponseBytes: 5,
          },
          baseContext,
        ),
      ).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
