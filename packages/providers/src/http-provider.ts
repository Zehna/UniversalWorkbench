import { createEgressPolicy, type EgressPolicy } from "@uw/egress";
import {
  estimateTokensForText,
  ProviderError,
  type AiProvider,
  type ProviderRequest,
  type ProviderResult,
  type ProviderToolCall,
} from "./types.js";

const DEFAULT_MAX_RESPONSE_BYTES = 262_144; // 256 KiB
const MAX_REDIRECTS = 5;

export interface HttpProviderOptions {
  id?: string;
  baseUrl: string;
  policy?: EgressPolicy;
  fetchImpl?: typeof fetch;
  maxResponseBytes?: number;
}

interface ChatCompletionsResponse {
  id?: unknown;
  choices?: unknown;
  usage?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function joinCompletionsUrl(baseUrl: string): URL {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new ProviderError(
      "INVALID_CONFIG",
      "AI provider base URL is invalid",
    );
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new ProviderError(
      "INVALID_CONFIG",
      "AI provider base URL is invalid",
    );
  }
  const normalized = base.toString().endsWith("/")
    ? base.toString()
    : `${base.toString()}/`;
  try {
    return new URL("chat/completions", normalized);
  } catch {
    throw new ProviderError(
      "INVALID_CONFIG",
      "AI provider base URL is invalid",
    );
  }
}

function validateRequest(req: ProviderRequest): void {
  if (!req.model || !req.prompt) {
    throw new ProviderError("INVALID_CONFIG", "AI provider request is invalid");
  }
  if (
    !Number.isInteger(req.maxOutputTokens) ||
    req.maxOutputTokens < 1 ||
    !Number.isInteger(req.timeoutMs) ||
    req.timeoutMs < 1
  ) {
    throw new ProviderError("INVALID_CONFIG", "AI provider request is invalid");
  }
  if (!req.secretValue) {
    throw new ProviderError("INVALID_CONFIG", "AI provider request is invalid");
  }
}

function buildBody(req: ProviderRequest): string {
  const messages: Array<{ role: string; content: string }> = [];
  if (req.systemPrompt)
    messages.push({ role: "system", content: req.systemPrompt });
  messages.push({ role: "user", content: req.prompt });
  const body: Record<string, unknown> = {
    model: req.model,
    messages,
    max_tokens: req.maxOutputTokens,
  };
  if (req.responseFormat?.kind === "json") {
    body.response_format = { type: "json_object" };
  }
  if (req.tools !== undefined && req.tools.length > 0) {
    body.tools = req.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        ...(tool.description !== undefined
          ? { description: tool.description }
          : {}),
        parameters: tool.parameters,
      },
    }));
  }
  return JSON.stringify(body);
}

function extractText(payload: ChatCompletionsResponse): string {
  if (!isRecord(payload)) return "";
  const choices = (payload as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const first = choices[0];
  if (!isRecord(first)) return "";
  const message = (first as Record<string, unknown>).message;
  if (!isRecord(message)) return "";
  const content = (message as Record<string, unknown>).content;
  return typeof content === "string" ? content : "";
}

function extractUsage(
  payload: ChatCompletionsResponse,
): ProviderResult["usage"] | null {
  if (!isRecord(payload)) return null;
  const usage = (payload as Record<string, unknown>).usage;
  if (!isRecord(usage)) return null;
  const prompt = (usage as Record<string, unknown>).prompt_tokens;
  const completion = (usage as Record<string, unknown>).completion_tokens;
  const total = (usage as Record<string, unknown>).total_tokens;
  if (
    typeof prompt !== "number" ||
    typeof completion !== "number" ||
    typeof total !== "number" ||
    !Number.isInteger(prompt) ||
    !Number.isInteger(completion) ||
    !Number.isInteger(total) ||
    prompt < 0 ||
    completion < 0 ||
    total < 0
  ) {
    return null;
  }
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: total,
  };
}

function extractToolCalls(
  payload: ChatCompletionsResponse,
): ProviderToolCall[] | undefined {
  if (!isRecord(payload)) return undefined;
  const choices = (payload as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const first = choices[0];
  if (!isRecord(first)) return undefined;
  const message = (first as Record<string, unknown>).message;
  if (!isRecord(message)) return undefined;
  const rawCalls = (message as Record<string, unknown>).tool_calls;
  if (rawCalls === undefined) return undefined;
  if (!Array.isArray(rawCalls)) return undefined;
  const calls: ProviderToolCall[] = [];
  for (const raw of rawCalls) {
    if (!isRecord(raw)) continue;
    const fn = (raw as Record<string, unknown>).function;
    if (!isRecord(fn)) continue;
    const name = (fn as Record<string, unknown>).name;
    if (typeof name !== "string" || name.length === 0) continue;
    const rawArgs = (fn as Record<string, unknown>).arguments;
    let parsedArgs: Record<string, unknown> = {};
    if (typeof rawArgs === "string") {
      const trimmed = rawArgs.trim();
      if (trimmed.length > 0) {
        try {
          const parsed: unknown = JSON.parse(trimmed);
          if (isRecord(parsed)) parsedArgs = parsed;
        } catch {
          parsedArgs = {};
        }
      }
    } else if (isRecord(rawArgs)) {
      parsedArgs = rawArgs as Record<string, unknown>;
    }
    const id = (raw as Record<string, unknown>).id;
    const call: ProviderToolCall =
      typeof id === "string" && id.length > 0
        ? { id, name, arguments: parsedArgs }
        : { name, arguments: parsedArgs };
    calls.push(call);
  }
  return calls;
}

function extractRequestId(
  payload: ChatCompletionsResponse,
): string | undefined {
  if (!isRecord(payload)) return undefined;
  const id = (payload as Record<string, unknown>).id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

export function createHttpProvider(options: HttpProviderOptions): AiProvider {
  const id = options.id ?? "http";
  const policy = options.policy ?? createEgressPolicy();
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const maxResponseBytes =
    options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const startUrl = joinCompletionsUrl(options.baseUrl);

  return {
    id,
    async complete(req: ProviderRequest): Promise<ProviderResult> {
      validateRequest(req);
      const timeoutSignal =
        typeof AbortSignal.timeout === "function"
          ? AbortSignal.timeout(req.timeoutMs)
          : (() => {
              const controller = new AbortController();
              setTimeout(() => controller.abort(), req.timeoutMs).unref?.();
              return controller.signal;
            })();
      const combined =
        typeof AbortSignal.any === "function"
          ? AbortSignal.any([req.signal, timeoutSignal])
          : req.signal;

      const requestBody = buildBody(req);
      let current = startUrl;

      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        if (req.signal.aborted) {
          throw new ProviderError(
            "ABORTED",
            "AI provider request was cancelled",
          );
        }
        if (combined.aborted && !req.signal.aborted) {
          throw new ProviderError("TIMEOUT", "AI provider request timed out");
        }
        try {
          await policy.assertAllowed(current);
        } catch (error) {
          if (
            isRecord(error) &&
            ((error as Record<string, unknown>).code === "EGRESS_BLOCKED" ||
              (error as Record<string, unknown>).code === "DNS_FAILURE")
          ) {
            const code = (error as Record<string, unknown>).code as
              "EGRESS_BLOCKED" | "DNS_FAILURE";
            throw new ProviderError(
              code,
              code === "EGRESS_BLOCKED"
                ? "Outbound destination is not permitted"
                : "Outbound hostname could not be resolved",
            );
          }
          throw error;
        }

        const headers: Record<string, string> = {
          "content-type": "application/json",
          Authorization: `Bearer ${req.secretValue}`,
        };
        if (req.idempotencyKey) headers["Idempotency-Key"] = req.idempotencyKey;
        if (hop > 0) {
          delete headers.Authorization;
          delete headers.authorization;
          delete headers["proxy-authorization"];
          delete headers["Proxy-Authorization"];
        }

        let response: Response;
        try {
          const init: RequestInit = {
            method: "POST",
            headers,
            redirect: "manual",
            signal: combined,
          };
          if (hop === 0) init.body = requestBody;
          response = await fetchImpl(current.toString(), init);
        } catch (error) {
          if (req.signal.aborted) {
            throw new ProviderError(
              "ABORTED",
              "AI provider request was cancelled",
            );
          }
          if (
            combined.aborted ||
            (error instanceof Error && error.name === "AbortError")
          ) {
            throw new ProviderError("TIMEOUT", "AI provider request timed out");
          }
          throw new ProviderError(
            "NETWORK_FAILURE",
            "AI provider request failed",
          );
        }

        if (req.signal.aborted) {
          throw new ProviderError(
            "ABORTED",
            "AI provider request was cancelled",
          );
        }
        if (combined.aborted) {
          throw new ProviderError("TIMEOUT", "AI provider request timed out");
        }

        const location = response.headers.get("location");
        if ([301, 302, 303, 307, 308].includes(response.status) && location) {
          if (hop === MAX_REDIRECTS) {
            throw new ProviderError(
              "NETWORK_FAILURE",
              "AI provider redirect limit was exceeded",
            );
          }
          let next: URL;
          try {
            next = new URL(location, current);
          } catch {
            throw new ProviderError(
              "NETWORK_FAILURE",
              "AI provider redirect target was invalid",
            );
          }
          if (current.protocol === "https:" && next.protocol !== "https:") {
            throw new ProviderError(
              "EGRESS_BLOCKED",
              "Outbound destination is not permitted",
            );
          }
          current = next;
          continue;
        }

        if (response.status < 200 || response.status >= 300) {
          throw new ProviderError(
            "PROVIDER_ERROR",
            `AI provider request failed (status ${response.status})`,
          );
        }

        let text: string;
        try {
          text = await response.text();
        } catch {
          if (req.signal.aborted) {
            throw new ProviderError(
              "ABORTED",
              "AI provider request was cancelled",
            );
          }
          throw new ProviderError(
            "NETWORK_FAILURE",
            "AI provider request failed",
          );
        }
        if (new TextEncoder().encode(text).byteLength > maxResponseBytes) {
          throw new ProviderError(
            "RESPONSE_TOO_LARGE",
            "AI provider response exceeded the configured limit",
          );
        }

        let payload: ChatCompletionsResponse;
        try {
          payload = JSON.parse(text) as ChatCompletionsResponse;
        } catch {
          throw new ProviderError(
            "PROVIDER_ERROR",
            "AI provider returned an invalid response",
          );
        }

        const content = extractText(payload);
        const toolCalls = extractToolCalls(payload);
        if (!content && (!toolCalls || toolCalls.length === 0)) {
          throw new ProviderError(
            "PROVIDER_ERROR",
            "AI provider returned an invalid response",
          );
        }

        const reported = extractUsage(payload);
        const usage: ProviderResult["usage"] = reported ?? {
          promptTokens: estimateTokensForText(req.prompt),
          completionTokens: estimateTokensForText(content),
          totalTokens:
            estimateTokensForText(req.prompt) + estimateTokensForText(content),
        };
        const result: ProviderResult = {
          text: content,
          model: req.model,
          usage,
          usageSource: reported ? "provider" : "estimated",
        };
        if (toolCalls !== undefined && toolCalls.length > 0) {
          result.toolCalls = toolCalls;
        }
        const requestId = extractRequestId(payload);
        if (requestId) result.providerRequestId = requestId;
        if (req.responseFormat?.kind === "json") {
          try {
            result.structured = JSON.parse(content) as unknown;
          } catch {
            // Leave unstructured; the AI tool validates against the schema.
          }
        }
        return result;
      }
      throw new ProviderError(
        "NETWORK_FAILURE",
        "AI provider redirect limit was exceeded",
      );
    },
  };
}
