import { describe, expect, it, vi } from "vitest";
import {
  SafeDnsResolver,
  SafeHttpTransport,
  ToolExecutionError,
  type HttpConnector,
  type HttpConnectorRequest,
  type HttpConnectorResponse,
} from "../src/index.js";

function body(...chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

function response(
  status: number,
  headers: Record<string, string | string[] | undefined> = {},
  chunks: Uint8Array[] = [],
): HttpConnectorResponse {
  return {
    status,
    headers,
    body: body(...chunks),
  };
}

function resolver(
  records: Record<string, { address: string; family: 4 | 6 }[]>,
): SafeDnsResolver {
  return new SafeDnsResolver(async (hostname) => records[hostname] ?? []);
}

function connector(
  implementation: (
    request: HttpConnectorRequest,
  ) => Promise<HttpConnectorResponse>,
): HttpConnector {
  return { request: vi.fn(implementation) };
}

describe("SafeDnsResolver", () => {
  it("rejects a hostname when any DNS result is non-public", async () => {
    const dns = resolver({
      "mixed.example": [
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.7", family: 4 },
      ],
    });

    await expect(dns.resolvePublic("mixed.example")).rejects.toMatchObject({
      code: "UNSAFE_EGRESS",
    });
  });

  it("returns only the validated public addresses", async () => {
    const dns = resolver({
      "public.example": [
        { address: "93.184.216.34", family: 4 },
        { address: "2606:4700:4700::1111", family: 6 },
      ],
    });

    await expect(dns.resolvePublic("public.example")).resolves.toEqual([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ]);
  });
});

describe("SafeHttpTransport", () => {
  it("pins the validated DNS address into the connector request", async () => {
    const dns = resolver({
      "public.example": [{ address: "93.184.216.34", family: 4 }],
    });
    const http = connector(async (request) => {
      expect(request.url.hostname).toBe("public.example");
      expect(request.resolvedAddress).toEqual({
        address: "93.184.216.34",
        family: 4,
      });
      return response(200, {}, [new TextEncoder().encode("ok")]);
    });
    const transport = new SafeHttpTransport({ resolver: dns, connector: http });

    await expect(
      transport.request({ url: "https://public.example/data", method: "GET" }),
    ).resolves.toMatchObject({
      status: 200,
      finalUrl: "https://public.example/data",
    });
  });

  it("revalidates every redirect hop and blocks a redirect to private space", async () => {
    const dns = resolver({
      "public.example": [{ address: "93.184.216.34", family: 4 }],
      "internal.example": [{ address: "10.0.0.9", family: 4 }],
    });
    const http = connector(async () =>
      response(302, { location: "http://internal.example/metadata" }),
    );
    const transport = new SafeHttpTransport({ resolver: dns, connector: http });

    await expect(
      transport.request({ url: "https://public.example/start", method: "GET" }),
    ).rejects.toMatchObject({ code: "UNSAFE_EGRESS" });
    expect(http.request).toHaveBeenCalledTimes(1);
  });

  it("sanitizes credential-bearing response headers", async () => {
    const dns = resolver({
      "public.example": [{ address: "93.184.216.34", family: 4 }],
    });
    const http = connector(async () =>
      response(
        200,
        {
          "content-type": "application/json",
          "set-cookie": ["session=secret"],
          "proxy-authenticate": "Basic secret",
          "www-authenticate": "Bearer secret",
          "x-safe": "yes",
        },
        [new TextEncoder().encode("{}")],
      ),
    );
    const transport = new SafeHttpTransport({ resolver: dns, connector: http });

    const result = await transport.request({
      url: "https://public.example/data",
      method: "GET",
    });

    expect(result.headers).toEqual({
      "content-type": "application/json",
      "x-safe": "yes",
    });
  });

  it("rejects a response body above the configured byte limit", async () => {
    const dns = resolver({
      "public.example": [{ address: "93.184.216.34", family: 4 }],
    });
    const http = connector(async () =>
      response(200, {}, [new Uint8Array(6), new Uint8Array(6)]),
    );
    const transport = new SafeHttpTransport({ resolver: dns, connector: http });

    await expect(
      transport.request({
        url: "https://public.example/data",
        method: "GET",
        maxResponseBytes: 10,
      }),
    ).rejects.toMatchObject({ code: "OUTPUT_TOO_LARGE" });
  });

  it("turns its own timeout into a TIMEOUT tool error", async () => {
    const dns = resolver({
      "public.example": [{ address: "93.184.216.34", family: 4 }],
    });
    const http = connector(
      (request) =>
        new Promise((_, reject) => {
          request.signal.addEventListener(
            "abort",
            () => reject(request.signal.reason),
            { once: true },
          );
        }),
    );
    const transport = new SafeHttpTransport({ resolver: dns, connector: http });

    await expect(
      transport.request({
        url: "https://public.example/slow",
        method: "GET",
        timeoutMs: 5,
      }),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("preserves external cancellation as CANCELLED", async () => {
    const dns = resolver({
      "public.example": [{ address: "93.184.216.34", family: 4 }],
    });
    const http = connector(
      (request) =>
        new Promise((_, reject) => {
          request.signal.addEventListener(
            "abort",
            () => reject(request.signal.reason),
            { once: true },
          );
        }),
    );
    const transport = new SafeHttpTransport({ resolver: dns, connector: http });
    const controller = new AbortController();
    const pending = transport.request({
      url: "https://public.example/slow",
      method: "GET",
      signal: controller.signal,
      timeoutMs: 1_000,
    });

    controller.abort(new DOMException("cancelled", "AbortError"));

    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
  });
});
