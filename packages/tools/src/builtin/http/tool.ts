import { z } from "zod";
import type {
  ContextEnvelope,
  ToolDefinition,
} from "@uw/contracts";
import type { ToolRunner } from "../../contract.js";
import { ToolExecutionError } from "../../errors.js";
import {
  SafeHttpTransport,
  type HttpMethod,
  type SafeHttpTransportLike,
} from "./transport.js";

const HttpMethodSchema = z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);

const HttpToolConfigSchema = z
  .object({
    url: z.string().trim().min(1),
    method: HttpMethodSchema.default("GET"),
    headers: z.record(z.string(), z.string()).optional(),
  })
  .strict();

const MAX_INLINE_BODY_BYTES = 1024 * 1024;

export interface HttpArtifactWriter {
  create(
    ownerId: string,
    projectId: string,
    input: {
      type: string;
      mimeType: string;
      bytes: Uint8Array;
      metadata: Record<string, unknown>;
    },
    traceId: string,
  ): Promise<{ id: string }>;
}

export interface HttpContextIdGenerator {
  next(): string;
}

export interface CreateHttpRequestToolOptions {
  transport?: SafeHttpTransportLike;
  artifacts: HttpArtifactWriter;
  contextIds: HttpContextIdGenerator;
}

export const HTTP_REQUEST_TOOL_DEFINITION: ToolDefinition = {
  id: "builtin.http.request",
  version: "1",
  displayName: "HTTP Request",
  description: "Request a public HTTP or HTTPS resource through safe egress",
  executionMode: "worker",
  accepts: [
    {
      name: "body",
      types: ["text", "json"],
      required: false,
    },
  ],
  produces: [
    {
      name: "response",
      types: ["api-response"],
    },
  ],
  configSchema: {
    type: "object",
    required: ["url"],
    additionalProperties: false,
    properties: {
      url: { type: "string" },
      method: {
        type: "string",
        enum: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
      },
      headers: {
        type: "object",
        additionalProperties: { type: "string" },
      },
    },
  },
  requiredCapabilities: ["network.public", "project.artifacts.write"],
  defaults: {
    timeoutMs: 15_000,
    maxAttempts: 3,
  },
};

function bodyBytes(
  input: ContextEnvelope | undefined,
): { bytes?: Uint8Array; contentType?: string } {
  if (!input) return {};

  const ensureLimit = (bytes: Uint8Array): Uint8Array => {
    if (bytes.byteLength > MAX_INLINE_BODY_BYTES) {
      throw new ToolExecutionError({
        code: "OUTPUT_TOO_LARGE",
        message: "HTTP request body exceeds the inline context limit",
        retrySafe: false,
      });
    }
    return bytes;
  };

  if (input.type === "text") {
    if (typeof input.payload !== "string") {
      throw new ToolExecutionError({
        code: "VALIDATION",
        message: "HTTP text body must contain a string payload",
        retrySafe: false,
      });
    }
    return {
      bytes: ensureLimit(new TextEncoder().encode(input.payload)),
      contentType: "text/plain; charset=utf-8",
    };
  }

  if (input.type === "json") {
    return {
      bytes: ensureLimit(
        new TextEncoder().encode(JSON.stringify(input.payload)),
      ),
      contentType: "application/json",
    };
  }

  throw new ToolExecutionError({
    code: "VALIDATION",
    message: "HTTP body input must be text or json",
    retrySafe: false,
  });
}

function bodyMimeType(headers: Record<string, string>): string {
  const contentType = headers["content-type"];
  if (!contentType) return "application/octet-stream";
  const [mimeType] = contentType.split(";", 1);
  return mimeType?.trim() || "application/octet-stream";
}

function parseRetryAfter(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }

  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function throwForHttpStatus(
  status: number,
  headers: Record<string, string>,
  method: HttpMethod,
): void {
  if (status < 400) return;

  const common = {
    method,
    ambiguous: false,
    retrySafe: method === "GET" || method === "HEAD",
  };

  if (status === 429) {
    const retryAfterMs = parseRetryAfter(headers["retry-after"]);
    throw new ToolExecutionError({
      code: "UPSTREAM_RATE_LIMIT",
      message: "HTTP upstream rate limited the request",
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      ...common,
    });
  }
  if (status === 408) {
    throw new ToolExecutionError({
      code: "NETWORK_TRANSIENT",
      message: "HTTP upstream timed out the request",
      ...common,
    });
  }
  if (status >= 500) {
    throw new ToolExecutionError({
      code: "UPSTREAM_5XX",
      message: `HTTP upstream returned status ${status}`,
      ...common,
    });
  }
  throw new ToolExecutionError({
    code: "UPSTREAM_4XX",
    message: `HTTP upstream returned status ${status}`,
    ...common,
  });
}

export function createHttpRequestTool(
  options: CreateHttpRequestToolOptions,
): ToolRunner {
  const transport = options.transport ?? new SafeHttpTransport();

  return {
    async run(context) {
      const parsedConfig = HttpToolConfigSchema.safeParse(context.config);
      if (!parsedConfig.success) {
        throw new ToolExecutionError({
          code: "VALIDATION",
          message: "HTTP tool configuration is invalid",
          retrySafe: false,
        });
      }
      const config = parsedConfig.data;
      const preparedBody = bodyBytes(context.inputs.body);
      const headers = { ...(config.headers ?? {}) };
      const hasContentType = Object.keys(headers).some(
        (name) => name.toLowerCase() === "content-type",
      );
      if (preparedBody.contentType && !hasContentType) {
        headers["content-type"] = preparedBody.contentType;
      }

      const response = await transport.request({
        url: config.url,
        method: config.method,
        headers,
        ...(preparedBody.bytes === undefined
          ? {}
          : { body: preparedBody.bytes }),
        signal: context.signal,
        timeoutMs: HTTP_REQUEST_TOOL_DEFINITION.defaults.timeoutMs,
      });

      throwForHttpStatus(response.status, response.headers, config.method);

      const mimeType = bodyMimeType(response.headers);
      const artifact = await options.artifacts.create(
        context.ownerId,
        context.projectId,
        {
          type: "http-response-body",
          mimeType,
          bytes: response.body,
          metadata: {
            source: "http",
            status: response.status,
            url: response.finalUrl,
          },
        },
        context.traceId,
      );

      const parentContextIds = Object.values(context.inputs).map(
        (input) => input.id,
      );
      const output: ContextEnvelope = {
        id: options.contextIds.next(),
        type: "api-response",
        schemaVersion: 1,
        mimeType,
        metadata: {},
        payload: {
          status: response.status,
          headers: response.headers,
          url: response.finalUrl,
          bodyArtifactId: artifact.id,
          bodyMimeType: mimeType,
          bodySizeBytes: response.body.byteLength,
        },
        provenance: {
          projectId: context.projectId,
          artifactIds: [artifact.id],
          executionId: context.executionId,
          stepExecutionId: context.stepExecutionId,
          parentContextIds,
        },
        capabilities: [],
      };

      return {
        outputs: { response: output },
        usage: {
          outputBytes: response.body.byteLength,
          httpRequests: response.requestCount ?? 1,
        },
      };
    },
  };
}
