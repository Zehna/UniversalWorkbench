export { isSecretLikeKey, parseSecretRef } from "@uw/contracts";
export type { ParsedSecretRef, SecretScope } from "@uw/contracts";
import { isSecretLikeKey } from "@uw/contracts";

export const REDACTED = "[REDACTED]";

const USAGE_NUMERIC_KEYS = new Set([
  "promptTokens",
  "completionTokens",
  "totalTokens",
]);

function isValidUsageNumber(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    (value as number) >= 0
  );
}

function normalizeKnownSecrets(
  knownSecrets: readonly string[] | undefined,
): string[] {
  if (!knownSecrets) return [];
  const out = knownSecrets.filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );
  out.sort((a, b) => b.length - a.length);
  return out;
}

function scrubString(value: string, known: readonly string[]): string {
  let out = value;
  for (const secret of known) {
    if (out.includes(secret)) {
      out = out.split(secret).join(REDACTED);
    }
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function redactError(error: Error, known: readonly string[]): Error {
  const scrubbedMessage =
    known.length > 0 ? scrubString(error.message, known) : error.message;
  const copy = new Error(scrubbedMessage);
  copy.name = known.length > 0 ? scrubString(error.name, known) : error.name;
  if (typeof error.stack === "string") {
    copy.stack =
      known.length > 0 ? scrubString(error.stack, known) : error.stack;
  }
  const cause = (error as { cause?: unknown }).cause;
  if (cause !== undefined) {
    (copy as { cause?: unknown }).cause = redactValue(cause, known);
  }
  for (const [key, child] of Object.entries(error)) {
    if (
      key === "message" ||
      key === "stack" ||
      key === "name" ||
      key === "cause"
    ) {
      continue;
    }
    if (isSecretLikeKey(key)) {
      if (USAGE_NUMERIC_KEYS.has(key) && isValidUsageNumber(child)) {
        (copy as unknown as Record<string, unknown>)[key] = child;
      } else {
        (copy as unknown as Record<string, unknown>)[key] = REDACTED;
      }
    } else {
      (copy as unknown as Record<string, unknown>)[key] = redactValue(
        child,
        known,
      );
    }
  }
  return copy;
}

function redactValue(value: unknown, known: readonly string[]): unknown {
  if (typeof value === "string") {
    return known.length > 0 ? scrubString(value, known) : value;
  }
  if (value instanceof Error) {
    return redactError(value, known);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, known));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (isSecretLikeKey(key)) {
        if (USAGE_NUMERIC_KEYS.has(key) && isValidUsageNumber(child)) {
          out[key] = child;
        } else {
          out[key] = REDACTED;
        }
      } else {
        out[key] = redactValue(child, known);
      }
    }
    return out;
  }
  return value;
}

/**
 * Deep-clone JSON-like values, replacing values under secret-like keys
 * with "[REDACTED]". Numeric token-usage fields (`promptTokens`,
 * `completionTokens`, `totalTokens`) holding validated non-negative
 * integers are preserved.
 *
 * Field-name redaction alone cannot catch a raw secret embedded in an
 * otherwise benign string (e.g. an error `message`). Pass resolved
 * secret plaintexts via `knownSecrets` so every occurrence is scrubbed
 * from all strings, regardless of field name. Never log raw secrets
 * without supplying them here.
 *
 * `Error` instances are never returned as-is: a sanitized copy is
 * returned with `message`, `stack`, `cause`, and own enumerable fields
 * scrubbed. The original error is left untouched.
 */
export function redactSecrets(
  value: unknown,
  knownSecrets?: readonly string[],
): unknown {
  const known = normalizeKnownSecrets(knownSecrets);
  return redactValue(value, known);
}
