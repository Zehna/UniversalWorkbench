import { describe, expect, it } from "vitest";
import {
  classifyToolFailure,
  computeRetryDelay,
  type RetryClassificationInput,
} from "../src/index.js";

function classify(
  input: Partial<RetryClassificationInput> &
    Pick<RetryClassificationInput, "code">,
) {
  return classifyToolFailure({
    attempt: 1,
    maxAttempts: 3,
    retrySafe: true,
    ...input,
  });
}

describe("execution retry policy", () => {
  it("retries transient failures for retry-safe work", () => {
    expect(classify({ code: "NETWORK_TRANSIENT" }).retryable).toBe(true);
    expect(classify({ code: "UPSTREAM_RATE_LIMIT" }).retryable).toBe(true);
    expect(classify({ code: "UPSTREAM_5XX" }).retryable).toBe(true);
  });

  it("never retries policy, validation, cancellation, budget, or tool bugs", () => {
    for (const code of [
      "VALIDATION",
      "PERMISSION_DENIED",
      "UNSAFE_EGRESS",
      "UPSTREAM_4XX",
      "CANCELLED",
      "OUTPUT_TOO_LARGE",
      "BUDGET_EXCEEDED",
      "TOOL_BUG",
    ] as const) {
      expect(classify({ code }).retryable).toBe(false);
    }
  });

  it("does not replay an ambiguous non-idempotent POST", () => {
    expect(
      classify({
        code: "NETWORK_TRANSIENT",
        method: "POST",
        ambiguous: true,
        retrySafe: false,
      }).retryable,
    ).toBe(false);
  });

  it("allows an explicitly retry-safe POST", () => {
    expect(
      classify({
        code: "UPSTREAM_5XX",
        method: "POST",
        ambiguous: false,
        retrySafe: true,
      }).retryable,
    ).toBe(true);
  });

  it("caps retries at three attempts", () => {
    expect(
      classify({
        code: "NETWORK_TRANSIENT",
        attempt: 3,
        maxAttempts: 3,
      }).retryable,
    ).toBe(false);
  });

  it("uses bounded exponential backoff and bounded Retry-After", () => {
    expect(computeRetryDelay(1, undefined, () => 0.5)).toBe(500);
    expect(computeRetryDelay(2, undefined, () => 0.5)).toBe(1_000);
    expect(computeRetryDelay(1, 120_000, () => 0.5)).toBe(30_000);
  });
});
