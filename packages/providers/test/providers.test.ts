import { describe, expect, it, vi, afterEach } from "vitest";
import { createEgressPolicy } from "@uw/egress";
import {
  createHttpProvider,
  createMockProvider,
  isMockAllowed,
  ProviderError,
  type ProviderRequest,
} from "../src/index.js";

const SECRET = "sk-test-supersecret-abc123-VALUE";

function baseRequest(
  overrides: Partial<ProviderRequest> = {},
): ProviderRequest {
  return {
    model: "test-model",
    prompt: "hello world",
    responseFormat: { kind: "text" },
    maxOutputTokens: 128,
    timeoutMs: 1000,
    secretValue: SECRET,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function withEnv(env: Record<string, string | undefined>, fn: () => void) {
  const prevNodeEnv = process.env.NODE_ENV;
  const prevMock = process.env.WORKBENCH_AI_MOCK;
  const prevE2e = process.env.WORKBENCH_E2E_FIXTURE;
  const prevSmoke = process.env.WORKBENCH_DOCKER_SMOKE_FIXTURE;
  try {
    if (env.NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = env.NODE_ENV;
    if (env.WORKBENCH_AI_MOCK === undefined)
      delete process.env.WORKBENCH_AI_MOCK;
    else process.env.WORKBENCH_AI_MOCK = env.WORKBENCH_AI_MOCK;
    if (env.WORKBENCH_E2E_FIXTURE === undefined)
      delete process.env.WORKBENCH_E2E_FIXTURE;
    else process.env.WORKBENCH_E2E_FIXTURE = env.WORKBENCH_E2E_FIXTURE;
    if (env.WORKBENCH_DOCKER_SMOKE_FIXTURE === undefined)
      delete process.env.WORKBENCH_DOCKER_SMOKE_FIXTURE;
    else
      process.env.WORKBENCH_DOCKER_SMOKE_FIXTURE =
        env.WORKBENCH_DOCKER_SMOKE_FIXTURE;
    fn();
  } finally {
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
    if (prevMock === undefined) delete process.env.WORKBENCH_AI_MOCK;
    else process.env.WORKBENCH_AI_MOCK = prevMock;
    if (prevE2e === undefined) delete process.env.WORKBENCH_E2E_FIXTURE;
    else process.env.WORKBENCH_E2E_FIXTURE = prevE2e;
    if (prevSmoke === undefined)
      delete process.env.WORKBENCH_DOCKER_SMOKE_FIXTURE;
    else process.env.WORKBENCH_DOCKER_SMOKE_FIXTURE = prevSmoke;
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("mock provider", () => {
  it("is deterministic with byte/4 token math and estimated usage", async () => {
    withEnv({ NODE_ENV: "test", WORKBENCH_AI_MOCK: "1" }, () => {
      expect(isMockAllowed()).toBe(true);
    });
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("WORKBENCH_AI_MOCK", "1");
    const provider = createMockProvider();
    expect(provider.id).toBe("mock");
    const first = await provider.complete(baseRequest());
    const second = await provider.complete(baseRequest());
    expect(second).toEqual(first);
    expect(first.text).toBe(`mock:test-model:${"hello world".slice(0, 32)}`);
    expect(first.usageSource).toBe("estimated");
    const promptBytes = new TextEncoder().encode("hello world").byteLength;
    const textBytes = new TextEncoder().encode(first.text).byteLength;
    expect(first.usage.promptTokens).toBe(
      Math.max(1, Math.ceil(promptBytes / 4)),
    );
    expect(first.usage.completionTokens).toBe(
      Math.max(1, Math.ceil(textBytes / 4)),
    );
    expect(first.usage.totalTokens).toBe(
      first.usage.promptTokens + first.usage.completionTokens,
    );
    expect(first.model).toBe("test-model");
  });

  it("honors json format by returning { echo: prompt }", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("WORKBENCH_AI_MOCK", "1");
    const provider = createMockProvider();
    const result = await provider.complete(
      baseRequest({
        responseFormat: { kind: "json", jsonSchema: { type: "object" } },
      }),
    );
    expect(result.structured).toEqual({ echo: "hello world" });
    expect(result.usageSource).toBe("estimated");
  });

  it("rejects MOCK_NOT_ALLOWED outside the flag matrix", () => {
    // prod env even with flag
    withEnv({ NODE_ENV: "production", WORKBENCH_AI_MOCK: "1" }, () => {
      expect(isMockAllowed()).toBe(false);
      expect(() => createMockProvider()).toThrowError(
        expect.objectContaining({ code: "MOCK_NOT_ALLOWED" }),
      );
    });
    // test env without any flag
    withEnv({ NODE_ENV: "test" }, () => {
      expect(isMockAllowed()).toBe(false);
      expect(() => createMockProvider()).toThrowError(
        expect.objectContaining({ code: "MOCK_NOT_ALLOWED" }),
      );
    });
    // test + explicit mock flag allowed
    withEnv({ NODE_ENV: "test", WORKBENCH_AI_MOCK: "1" }, () => {
      expect(isMockAllowed()).toBe(true);
      expect(() => createMockProvider()).not.toThrow();
    });
    // smoke fixture allowed
    withEnv({ NODE_ENV: "test", WORKBENCH_DOCKER_SMOKE_FIXTURE: "1" }, () => {
      expect(isMockAllowed()).toBe(true);
      expect(() => createMockProvider()).not.toThrow();
    });
  });
});

describe("http provider", () => {
  const policy = () =>
    createEgressPolicy({ resolver: async () => ["93.184.216.34"] });

  function jsonFetch(body: unknown, init?: { requestId?: string }) {
    return vi.fn(async () => {
      const text = JSON.stringify(body);
      return new Response(text, {
        status: 200,
        headers: {
          "content-type": "application/json",
          ...(init?.requestId ? { "x-request-id": init.requestId } : {}),
        },
      });
    });
  }

  it("posts OpenAI-compatible chat completions and keeps provider usage verbatim", async () => {
    let seenUrl = "";
    let seenBody: Record<string, unknown> = {};
    let seenAuth = "";
    const fetchImpl = vi.fn(async (url: unknown, init: unknown) => {
      seenUrl = String(url);
      seenBody = JSON.parse(
        String((init as { body?: string }).body ?? "{}"),
      ) as Record<string, unknown>;
      seenAuth = String(
        ((init as { headers?: Record<string, string> }).headers ?? {})[
          "Authorization"
        ] ?? "",
      );
      return new Response(
        JSON.stringify({
          id: "chatcmpl-123",
          choices: [{ message: { content: "hi there" } }],
          usage: {
            prompt_tokens: 7,
            completion_tokens: 9,
            total_tokens: 16,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const provider = createHttpProvider({
      id: "test-openai",
      baseUrl: "https://public.example.net/v1",
      policy: policy(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await provider.complete(baseRequest());
    expect(seenUrl).toBe("https://public.example.net/v1/chat/completions");
    expect(seenAuth).toBe(`Bearer ${SECRET}`);
    expect(seenBody).toMatchObject({ model: "test-model" });
    expect(result.text).toBe("hi there");
    expect(result.usage).toEqual({
      promptTokens: 7,
      completionTokens: 9,
      totalTokens: 16,
    });
    expect(result.usageSource).toBe("provider");
    expect(result.providerRequestId).toBe("chatcmpl-123");
    expect(jsonFetch).toBeDefined();
  });

  it("estimates usage when the provider omits it", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "abc" } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const provider = createHttpProvider({
      baseUrl: "https://public.example.net/v1",
      policy: policy(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await provider.complete(baseRequest({ prompt: "12345678" }));
    expect(result.usageSource).toBe("estimated");
    expect(result.usage.totalTokens).toBe(
      result.usage.promptTokens + result.usage.completionTokens,
    );
    expect(result.usage.promptTokens).toBe(
      Math.max(
        1,
        Math.ceil(new TextEncoder().encode("12345678").byteLength / 4),
      ),
    );
  });

  it("forwards idempotencyKey as Idempotency-Key header", async () => {
    let seenHeaders: Record<string, string> = {};
    const fetchImpl = vi.fn(async (_url: unknown, init: unknown) => {
      seenHeaders = {
        ...((init as { headers?: Record<string, string> }).headers ?? {}),
      };
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
        { status: 200 },
      );
    });
    const provider = createHttpProvider({
      baseUrl: "https://public.example.net/v1",
      policy: policy(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await provider.complete(baseRequest({ idempotencyKey: "op-999" }));
    expect(seenHeaders["Idempotency-Key"]).toBe("op-999");
  });

  it("rejects link-local baseUrl before any request bytes", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const provider = createHttpProvider({
      baseUrl: "http://169.254.169.254/",
      policy: policy(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(provider.complete(baseRequest())).rejects.toMatchObject({
      code: "EGRESS_BLOCKED",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a public→private redirect without following it", async () => {
    const redirectPolicy = createEgressPolicy({
      resolver: async (host: string) =>
        host === "public.example.net" ? ["93.184.216.34"] : ["10.0.0.7"],
    });
    const fetchImpl = vi.fn(async () => {
      return new Response("", {
        status: 302,
        headers: { location: "https://evil.example.net/secret" },
      });
    });
    const provider = createHttpProvider({
      baseUrl: "https://public.example.net/v1",
      policy: redirectPolicy,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(provider.complete(baseRequest())).rejects.toMatchObject({
      code: "EGRESS_BLOCKED",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("drops Authorization on redirect", async () => {
    const samePublic = createEgressPolicy({
      resolver: async () => ["93.184.216.34"],
    });
    const calls: Array<Record<string, string>> = [];
    const fetchImpl = vi.fn(async (_url: unknown, init: unknown) => {
      calls.push({
        ...((init as { headers?: Record<string, string> }).headers ?? {}),
      });
      if (calls.length === 1) {
        return new Response("", {
          status: 302,
          headers: {
            location: "https://other.example.net/v1/chat/completions",
          },
        });
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "after" } }] }),
        { status: 200 },
      );
    });
    const provider = createHttpProvider({
      baseUrl: "https://public.example.net/v1",
      policy: samePublic,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await provider.complete(baseRequest());
    expect(result.text).toBe("after");
    expect(calls[0]?.["Authorization"]).toBe(`Bearer ${SECRET}`);
    expect(calls[1]?.["Authorization"]).toBeUndefined();
  });

  it("aborts on timeout without leaking the secret", async () => {
    const fetchImpl = vi.fn(
      async (_url: unknown, init: unknown) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = (init as { signal?: AbortSignal }).signal;
          signal?.addEventListener("abort", () =>
            reject(new Error("fetch aborted")),
          );
        }),
    );
    const provider = createHttpProvider({
      baseUrl: "https://public.example.net/v1",
      policy: policy(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const outcome = await provider
      .complete(baseRequest({ timeoutMs: 20 }))
      .then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toBeInstanceOf(ProviderError);
      expect(outcome.error).toMatchObject({ code: "TIMEOUT" });
      expect(JSON.stringify(outcome.error)).not.toContain(SECRET);
      expect(String((outcome.error as Error).message)).not.toContain(SECRET);
    }
  });

  it("errors on oversize responses without returning partial data", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response("x".repeat(64), { status: 200 });
    });
    const provider = createHttpProvider({
      baseUrl: "https://public.example.net/v1",
      policy: policy(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxResponseBytes: 8,
    });
    await expect(provider.complete(baseRequest())).rejects.toMatchObject({
      code: "RESPONSE_TOO_LARGE",
    });
  });

  it("never includes the secret in provider error bodies", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: { message: `bad key ${SECRET} rejected` },
        }),
        { status: 401 },
      );
    });
    const provider = createHttpProvider({
      baseUrl: "https://public.example.net/v1",
      policy: policy(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const outcome = await provider.complete(baseRequest()).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      const serialized = JSON.stringify(outcome.error);
      expect(serialized).not.toContain(SECRET);
      expect(String((outcome.error as Error).message)).not.toContain(SECRET);
      expect(outcome.error).toBeInstanceOf(ProviderError);
    }
  });
});
