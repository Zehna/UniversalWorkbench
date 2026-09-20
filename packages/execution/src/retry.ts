import type { ExecutionErrorCode } from "@uw/contracts";

const HARD_MAX_ATTEMPTS = 3;
const MAX_DELAY_MS = 30_000;
const BASE_DELAY_MS = 500;

export interface RetryClassificationInput {
  code: ExecutionErrorCode;
  attempt: number;
  maxAttempts: number;
  retrySafe: boolean;
  method?: string;
  ambiguous?: boolean;
  retryAfterMs?: number;
}

export interface RetryDecision {
  retryable: boolean;
  reason:
    | "retryable"
    | "attempts_exhausted"
    | "unsafe_replay"
    | "non_retryable_code";
}

const retryableCodes = new Set<ExecutionErrorCode>([
  "NETWORK_TRANSIENT",
  "UPSTREAM_RATE_LIMIT",
  "UPSTREAM_5XX",
  "TIMEOUT",
]);

function isSafeHttpMethod(method: string | undefined): boolean {
  if (!method) return false;
  const normalized = method.toUpperCase();
  return normalized === "GET" || normalized === "HEAD";
}

export function classifyToolFailure(
  input: RetryClassificationInput,
): RetryDecision {
  const effectiveMaxAttempts = Math.min(
    HARD_MAX_ATTEMPTS,
    Math.max(1, input.maxAttempts),
  );

  if (input.attempt >= effectiveMaxAttempts) {
    return { retryable: false, reason: "attempts_exhausted" };
  }

  if (!retryableCodes.has(input.code)) {
    return { retryable: false, reason: "non_retryable_code" };
  }

  const safeMethod = isSafeHttpMethod(input.method);
  if (input.method && !safeMethod && !input.retrySafe) {
    return { retryable: false, reason: "unsafe_replay" };
  }

  if (input.ambiguous && !safeMethod && !input.retrySafe) {
    return { retryable: false, reason: "unsafe_replay" };
  }

  if (!input.method && !input.retrySafe) {
    return { retryable: false, reason: "unsafe_replay" };
  }

  return { retryable: true, reason: "retryable" };
}

export function computeRetryDelay(
  attempt: number,
  retryAfterMs?: number,
  random: () => number = Math.random,
): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new RangeError("attempt must be a positive safe integer");
  }

  if (retryAfterMs !== undefined) {
    if (!Number.isFinite(retryAfterMs) || retryAfterMs < 0) {
      throw new RangeError("retryAfterMs must be a non-negative finite number");
    }
    return Math.min(MAX_DELAY_MS, Math.round(retryAfterMs));
  }

  const base = Math.min(
    MAX_DELAY_MS,
    BASE_DELAY_MS * 2 ** Math.min(attempt - 1, 10),
  );
  const boundedRandom = Math.min(1, Math.max(0, random()));
  const jitterFactor = 0.5 + boundedRandom;
  return Math.min(MAX_DELAY_MS, Math.max(1, Math.round(base * jitterFactor)));
}
