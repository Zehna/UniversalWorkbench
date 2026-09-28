import type { lookup as dnsLookup } from "node:dns";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { z } from "zod";
import { ToolDescriptorSchema } from "@uw/contracts";
import { ToolRuntimeError } from "../errors.js";
import type { ToolExecutor } from "../runtime.js";
import { createLocalResult, validateInvocation } from "../runtime.js";
import {
  createEgressPolicy,
  EgressPolicyError,
  type EgressPolicy,
} from "./egress-policy.js";

const methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] as const;
export type HttpMethod = (typeof methods)[number];

const httpConfigSchema = z.strictObject({
  method: z.enum(methods),
  url: z.string().min(1).max(4096),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().max(8_388_608).optional(),
  timeoutMs: z.number().int().min(1).max(30_000).optional(),
  maxResponseBytes: z.number().int().min(1).max(8_388_608).optional(),
});

export type HttpToolConfig = z.infer<typeof httpConfigSchema>;

export interface HttpTransportResponse {
  status: number;
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  body: Uint8Array;
}

export interface HttpTransport {
  request(
    url: URL,
    pinnedAddress: string,
    options: {
      method: HttpMethod;
      headers: Readonly<Record<string, string>>;
      body?: string;
      signal: AbortSignal;
      maxResponseBytes: number;
    },
  ): Promise<HttpTransportResponse>;
}

export function classifyHttpIdempotency(
  method: HttpMethod,
  idempotencyKey?: string,
): "safe" | "keyed" | "unsafe" {
  if (method === "GET" || method === "HEAD") return "safe";
  return idempotencyKey ? "keyed" : "unsafe";
}

const descriptor = ToolDescriptorSchema.parse({
  id: "builtin.http.request",
  version: "1.0.0",
  name: "HTTP Request",
  description: "Policy-gated outbound HTTP with bounded responses",
  accepts: ["json", "text", "markdown"],
  produces: ["api_response"],
  permissions: ["network"],
  capabilities: ["network"],
  executionMode: "server",
  // A registry descriptor is static: default to unsafe; the scheduler must
  // classify each method and its workflow-provided idempotency key separately.
  idempotency: "unsafe",
  configSchema: {
    type: "object",
    required: ["url", "method"],
  },
});

const forbiddenRequestHeaders = new Set([
  "connection",
  "cookie",
  "cookie2",
  "host",
  "proxy-authorization",
  "proxy-connection",
  "transfer-encoding",
  "content-length",
  "upgrade",
  "te",
  "trailer",
  "keep-alive",
  "idempotency-key",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
]);

function hasForbiddenHeaderValue(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function cleanHeaders(
  raw: Record<string, string> | undefined,
): Record<string, string> {
  const cleaned: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  for (const [name, value] of Object.entries(raw ?? {})) {
    const key = name.toLowerCase();
    if (
      !/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(key) ||
      forbiddenRequestHeaders.has(key) ||
      hasForbiddenHeaderValue(value)
    ) {
      throw new ToolRuntimeError(
        "INVALID_CONFIG",
        "Forbidden HTTP request header",
      );
    }
    cleaned[key] = value;
  }
  return cleaned;
}

function firstHeader(
  value: string | readonly string[] | undefined,
): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}

function responseHeaders(
  headers: HttpTransportResponse["headers"],
): Record<string, string> {
  const allowed = new Set([
    "content-type",
    "cache-control",
    "etag",
    "last-modified",
  ]);
  const selected: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    const header = firstHeader(value);
    if (allowed.has(key) && header && !hasForbiddenHeaderValue(header)) {
      selected[key] = header;
    }
  }
  return selected;
}

function normalizeResponseHeaders(
  headers: IncomingHttpHeaders,
): Record<string, string | readonly string[] | undefined> {
  const result: Record<string, string | readonly string[] | undefined> = {};
  for (const [name, value] of Object.entries(headers)) {
    result[name.toLowerCase()] = value;
  }
  return result;
}

// The original URL remains the Host/SNI value, while lookup always supplies
// the already-validated IP. The OS never does a second DNS lookup.
export function createNodeHttpTransport(): HttpTransport {
  return {
    request(url, pinnedAddress, options) {
      return new Promise<HttpTransportResponse>((resolve, reject) => {
        const family = isIP(pinnedAddress);
        if (!family) {
          reject(
            new EgressPolicyError(
              "EGRESS_BLOCKED",
              "Outbound destination is not permitted",
            ),
          );
          return;
        }
        const pinnedLookup = ((
          _host: string,
          lookupOptions: unknown,
          callback: (
            error: null,
            address: string | { address: string; family: number }[],
            addressFamily?: number,
          ) => void,
        ) => {
          if (
            typeof lookupOptions === "object" &&
            lookupOptions !== null &&
            "all" in lookupOptions &&
            lookupOptions.all === true
          ) {
            callback(null, [{ address: pinnedAddress, family }]);
          } else {
            callback(null, pinnedAddress, family);
          }
        }) as typeof dnsLookup;
        const requester =
          url.protocol === "https:" ? httpsRequest : httpRequest;
        const req = requester(
          url,
          {
            method: options.method,
            headers: options.headers,
            lookup: pinnedLookup,
            agent: false,
            signal: options.signal,
          },
          (response) => {
            void (async () => {
              try {
                const declaredSize = Number(
                  firstHeader(response.headers["content-length"]),
                );
                if (
                  Number.isFinite(declaredSize) &&
                  declaredSize > options.maxResponseBytes
                ) {
                  throw new ToolRuntimeError(
                    "RESPONSE_TOO_LARGE",
                    "HTTP response exceeded the configured limit",
                  );
                }
                const chunks: Uint8Array[] = [];
                let length = 0;
                for await (const chunk of response) {
                  const bytes = new Uint8Array(chunk);
                  length += bytes.byteLength;
                  if (length > options.maxResponseBytes) {
                    throw new ToolRuntimeError(
                      "RESPONSE_TOO_LARGE",
                      "HTTP response exceeded the configured limit",
                    );
                  }
                  chunks.push(bytes);
                }
                const body = new Uint8Array(length);
                let offset = 0;
                for (const chunk of chunks) {
                  body.set(chunk, offset);
                  offset += chunk.byteLength;
                }
                resolve({
                  status: response.statusCode ?? 0,
                  headers: normalizeResponseHeaders(response.headers),
                  body,
                });
              } catch (error) {
                response.destroy();
                reject(error);
              }
            })();
          },
        );
        req.on("error", reject);
        if (options.body !== undefined) req.end(options.body);
        else req.end();
      });
    },
  };
}

function withAbort<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted)
    return Promise.reject(new Error("HTTP request cancelled"));
  return new Promise<T>((resolve, reject) => {
    const cancelled = () => reject(new Error("HTTP request cancelled"));
    signal.addEventListener("abort", cancelled, { once: true });
    void task.then(
      (value) => {
        signal.removeEventListener("abort", cancelled);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", cancelled);
        reject(error);
      },
    );
  });
}

export function createHttpTool(
  options: { policy?: EgressPolicy; transport?: HttpTransport } = {},
): ToolExecutor {
  const policy = options.policy ?? createEgressPolicy();
  const transport = options.transport ?? createNodeHttpTransport();

  return {
    descriptor: ToolDescriptorSchema.parse(descriptor),
    async run(input, config, context) {
      const validInput = validateInvocation(descriptor, input, context);
      const parsed = httpConfigSchema.safeParse(config);
      if (!parsed.success) {
        throw new ToolRuntimeError(
          "INVALID_CONFIG",
          "HTTP configuration is invalid",
        );
      }
      const requestConfig = parsed.data;
      const method = requestConfig.method;
      if (
        (method === "GET" || method === "HEAD") &&
        requestConfig.body !== undefined
      ) {
        throw new ToolRuntimeError(
          "INVALID_CONFIG",
          "GET and HEAD cannot include a request body",
        );
      }
      if (
        classifyHttpIdempotency(method, context.idempotencyKey) === "unsafe"
      ) {
        throw new ToolRuntimeError(
          "INVALID_CONFIG",
          "Mutating HTTP requests require a workflow idempotency key",
        );
      }

      let url: URL;
      try {
        url = new URL(requestConfig.url);
      } catch {
        throw new ToolRuntimeError("INVALID_CONFIG", "HTTP URL is invalid");
      }

      const baseHeaders = cleanHeaders(requestConfig.headers);
      if (context.idempotencyKey && method !== "GET" && method !== "HEAD") {
        baseHeaders["idempotency-key"] = context.idempotencyKey;
      }
      const timeout = AbortSignal.timeout(requestConfig.timeoutMs ?? 10_000);
      const signal = AbortSignal.any([context.signal, timeout]);
      const maxResponseBytes = requestConfig.maxResponseBytes ?? 1_048_576;

      try {
        let current = url;
        for (let hops = 0; hops <= 5; hops += 1) {
          if (signal.aborted) {
            throw new ToolRuntimeError("ABORTED", "HTTP request was cancelled");
          }
          // Validate every redirect; pass the IP into the pinned transport.
          const addresses = await withAbort(
            policy.resolveAllowed(current),
            signal,
          );
          if (signal.aborted) {
            throw new ToolRuntimeError("ABORTED", "HTTP request was cancelled");
          }
          const headers = { ...baseHeaders };
          if (hops > 0) {
            delete headers.authorization;
            delete headers["proxy-authorization"];
          }
          const requestOptions: Parameters<HttpTransport["request"]>[2] = {
            method,
            headers,
            signal,
            maxResponseBytes,
          };
          if (requestConfig.body !== undefined) {
            requestOptions.body = requestConfig.body;
          }

          const response = await withAbort(
            transport.request(current, addresses[0]!, requestOptions),
            signal,
          );
          if (
            !Number.isInteger(response.status) ||
            response.status < 100 ||
            response.status > 599 ||
            response.body.byteLength > maxResponseBytes
          ) {
            throw new ToolRuntimeError(
              "INVALID_OUTPUT",
              "HTTP transport returned an invalid response",
            );
          }
          const location = Object.entries(response.headers).find(
            ([key]) => key.toLowerCase() === "location",
          );
          const redirectLocation = firstHeader(location?.[1]);
          if (
            [301, 302, 303, 307, 308].includes(response.status) &&
            redirectLocation
          ) {
            if (hops === 5) {
              throw new ToolRuntimeError(
                "NETWORK_FAILURE",
                "HTTP redirect limit was exceeded",
              );
            }
            if (method !== "GET" && method !== "HEAD") {
              throw new ToolRuntimeError(
                "NETWORK_FAILURE",
                "Redirects for mutating requests are disabled",
              );
            }
            let next: URL;
            try {
              next = new URL(redirectLocation, current);
            } catch {
              throw new ToolRuntimeError(
                "NETWORK_FAILURE",
                "HTTP redirect target was invalid",
              );
            }
            if (current.protocol === "https:" && next.protocol !== "https:") {
              throw new EgressPolicyError(
                "EGRESS_BLOCKED",
                "Outbound destination is not permitted",
              );
            }
            current = next;
            continue;
          }

          return createLocalResult(descriptor, validInput, context, {
            type: "api_response",
            mimeType: "application/json",
            payload: {
              status: response.status,
              headers: responseHeaders(response.headers),
              body: new TextDecoder().decode(response.body),
            },
          });
        }
        throw new ToolRuntimeError(
          "NETWORK_FAILURE",
          "HTTP redirect limit was exceeded",
        );
      } catch (error) {
        if (timeout.aborted && !context.signal.aborted) {
          throw new ToolRuntimeError("TIMEOUT", "HTTP request timed out");
        }
        if (context.signal.aborted) {
          throw new ToolRuntimeError("ABORTED", "HTTP request was cancelled");
        }
        if (
          error instanceof ToolRuntimeError ||
          error instanceof EgressPolicyError
        ) {
          throw error;
        }
        throw new ToolRuntimeError("NETWORK_FAILURE", "HTTP request failed");
      }
    },
  };
}
