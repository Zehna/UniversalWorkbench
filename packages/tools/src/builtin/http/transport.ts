import * as http from "node:http";
import * as https from "node:https";
import { isIP } from "node:net";
import { ToolExecutionError } from "../../errors.js";
import { SafeDnsResolver, type ResolvedAddress } from "./dns.js";
import { SafeEgressPolicy } from "./policy.js";

export type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface HttpConnectorRequest {
  url: URL;
  resolvedAddress: ResolvedAddress;
  method: HttpMethod;
  headers: Record<string, string>;
  body?: Uint8Array;
  signal: AbortSignal;
}

export interface HttpConnectorResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Uint8Array>;
  close?: () => void;
}

export interface HttpConnector {
  request(request: HttpConnectorRequest): Promise<HttpConnectorResponse>;
}

export interface SafeHttpTransportRequest {
  url: string;
  method: HttpMethod;
  headers?: Record<string, string>;
  body?: Uint8Array;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxRedirects?: number;
  maxResponseBytes?: number;
}

export interface SafeHttpTransportResult {
  status: number;
  headers: Record<string, string>;
  finalUrl: string;
  body: Uint8Array;
  requestCount?: number;
}

export interface SafeHttpTransportLike {
  request(request: SafeHttpTransportRequest): Promise<SafeHttpTransportResult>;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const HARD_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

function boundedInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new ToolExecutionError({
      code: "VALIDATION",
      message: `${label} must be a finite integer`,
      retrySafe: false,
    });
  }
  return Math.min(max, Math.max(min, value));
}

function normalizedHostname(url: URL): string {
  return url.hostname.startsWith("[") && url.hostname.endsWith("]")
    ? url.hostname.slice(1, -1)
    : url.hostname;
}

export class NodeHttpConnector implements HttpConnector {
  request(input: HttpConnectorRequest): Promise<HttpConnectorResponse> {
    return new Promise((resolve, reject) => {
      const hostname = normalizedHostname(input.url);
      const requestImpl =
        input.url.protocol === "https:" ? https.request : http.request;

      const options: https.RequestOptions = {
        protocol: input.url.protocol,
        hostname,
        ...(input.url.port ? { port: input.url.port } : {}),
        method: input.method,
        path: `${input.url.pathname}${input.url.search}`,
        headers: input.headers,
        signal: input.signal,
        agent: false,
        maxHeaderSize: 32 * 1024,
        lookup: (_hostname, _options, callback) => {
          callback(
            null,
            input.resolvedAddress.address,
            input.resolvedAddress.family,
          );
        },
        ...(input.url.protocol === "https:" && isIP(hostname) === 0
          ? { servername: hostname }
          : {}),
      };

      const request = requestImpl(options, (response) => {
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: response,
          close: () => response.destroy(),
        });
      });

      request.once("error", reject);
      request.end(input.body);
    });
  }
}

interface SafeHttpTransportOptions {
  resolver?: SafeDnsResolver;
  connector?: HttpConnector;
  policy?: SafeEgressPolicy;
}

function isRedirect(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}

function firstHeader(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function readBody(
  response: HttpConnectorResponse,
  limit: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for await (const chunk of response.body) {
      total += chunk.byteLength;
      if (total > limit) {
        response.close?.();
        throw new ToolExecutionError({
          code: "OUTPUT_TOO_LARGE",
          message: "HTTP response exceeded the maximum body size",
          retrySafe: false,
        });
      }
      chunks.push(new Uint8Array(chunk));
    }
  } catch (error) {
    response.close?.();
    throw error;
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export class SafeHttpTransport implements SafeHttpTransportLike {
  readonly #resolver: SafeDnsResolver;
  readonly #connector: HttpConnector;
  readonly #policy: SafeEgressPolicy;

  constructor(options: SafeHttpTransportOptions = {}) {
    this.#resolver = options.resolver ?? new SafeDnsResolver();
    this.#connector = options.connector ?? new NodeHttpConnector();
    this.#policy = options.policy ?? new SafeEgressPolicy();
  }

  async request(input: SafeHttpTransportRequest): Promise<SafeHttpTransportResult> {
    const timeoutMs = boundedInteger(
      input.timeoutMs,
      DEFAULT_TIMEOUT_MS,
      1,
      HARD_TIMEOUT_MS,
      "timeoutMs",
    );
    const maxRedirects = boundedInteger(
      input.maxRedirects,
      MAX_REDIRECTS,
      0,
      MAX_REDIRECTS,
      "maxRedirects",
    );
    const maxResponseBytes = boundedInteger(
      input.maxResponseBytes,
      MAX_RESPONSE_BYTES,
      1,
      MAX_RESPONSE_BYTES,
      "maxResponseBytes",
    );
    const controller = new AbortController();
    let timedOut = false;
    let cancelled = false;

    const cancelFromExternal = () => {
      cancelled = true;
      controller.abort(input.signal?.reason ?? new DOMException("cancelled"));
    };
    input.signal?.addEventListener("abort", cancelFromExternal, { once: true });
    if (input.signal?.aborted) cancelFromExternal();

    const timer = globalThis.setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException("timeout", "TimeoutError"));
    }, timeoutMs);

    try {
      const headers = {
        ...this.#policy.validateHeaders(input.headers),
        "accept-encoding": "identity",
      };
      return await this.#requestHop(
        {
          url: input.url,
          method: input.method,
          headers,
          ...(input.body === undefined ? {} : { body: input.body }),
        },
        controller.signal,
        maxRedirects,
        maxResponseBytes,
        0,
      );
    } catch (error) {
      if (timedOut) {
        throw new ToolExecutionError({
          code: "TIMEOUT",
          message: "HTTP request timed out",
          method: input.method,
          ambiguous: input.method !== "GET" && input.method !== "HEAD",
          retrySafe: input.method === "GET" || input.method === "HEAD",
        });
      }
      if (cancelled || input.signal?.aborted) {
        throw new ToolExecutionError({
          code: "CANCELLED",
          message: "HTTP request was cancelled",
          method: input.method,
          retrySafe: false,
        });
      }
      if (error instanceof ToolExecutionError) throw error;

      throw new ToolExecutionError({
        code: "NETWORK_TRANSIENT",
        message: "HTTP network request failed",
        method: input.method,
        ambiguous: input.method !== "GET" && input.method !== "HEAD",
        retrySafe: input.method === "GET" || input.method === "HEAD",
      });
    } finally {
      globalThis.clearTimeout(timer);
      input.signal?.removeEventListener("abort", cancelFromExternal);
    }
  }

  async #requestHop(
    input: {
      url: string;
      method: HttpMethod;
      headers: Record<string, string>;
      body?: Uint8Array;
    },
    signal: AbortSignal,
    maxRedirects: number,
    maxResponseBytes: number,
    redirects: number,
  ): Promise<SafeHttpTransportResult> {
    const url = this.#policy.validateUrl(input.url);
    const addresses = await this.#resolver.resolvePublic(url.hostname);
    const resolvedAddress = addresses[0]!;
    const response = await this.#connector.request({
      url,
      resolvedAddress,
      method: input.method,
      headers: input.headers,
      ...(input.body === undefined ? {} : { body: input.body }),
      signal,
    });

    const location = firstHeader(response.headers.location);
    if (isRedirect(response.status) && location) {
      response.close?.();
      if (redirects >= maxRedirects) {
        throw new ToolExecutionError({
          code: "VALIDATION",
          message: "HTTP redirect limit exceeded",
          method: input.method,
          retrySafe: false,
        });
      }

      const next = new URL(location, url);
      const nextMethod = response.status === 303 ? "GET" : input.method;
      const nextHeaders = { ...input.headers };
      if (nextMethod === "GET" && input.method !== "GET") {
        delete nextHeaders["content-type"];
      }

      const result = await this.#requestHop(
        {
          url: next.toString(),
          method: nextMethod,
          headers: nextHeaders,
          ...(nextMethod === "GET"
            ? {}
            : input.body === undefined
              ? {}
              : { body: input.body }),
        },
        signal,
        maxRedirects,
        maxResponseBytes,
        redirects + 1,
      );
      return {
        ...result,
        requestCount: (result.requestCount ?? 1) + 1,
      };
    }

    const body = await readBody(response, maxResponseBytes);
    return {
      status: response.status,
      headers: this.#policy.sanitizeResponseHeaders(response.headers),
      finalUrl: url.toString(),
      body,
      requestCount: 1,
    };
  }
}
