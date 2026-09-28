import { z } from "zod";

export const SecretScopeSchema = z.enum(["vault", "local"]);

export const SecretRefSchema = z
  .string()
  .trim()
  .regex(
    /^secret:\/\/(vault|local)\/[a-z0-9][a-z0-9._-]{0,127}$/,
    "Secret ref must match secret://(vault|local)/[a-z0-9._-]+ (max 128 chars)",
  );

export type SecretScope = z.infer<typeof SecretScopeSchema>;
export type SecretRef = z.infer<typeof SecretRefSchema>;

export interface ParsedSecretRef {
  scope: SecretScope;
  name: string;
}

const SECRET_REF_RE =
  /^secret:\/\/(vault|local)\/([a-z0-9][a-z0-9._-]{0,127})$/;

export function parseSecretRef(ref: unknown): ParsedSecretRef {
  if (typeof ref !== "string") {
    throw new Error("Invalid secret ref");
  }
  const match = SECRET_REF_RE.exec(ref.trim());
  if (!match || match[1] === undefined || match[2] === undefined) {
    throw new Error("Invalid secret ref");
  }
  return { scope: match[1] as SecretScope, name: match[2] };
}

const SECRET_LIKE_RE =
  /(api[_-]?key|secret|token|password|authorization|bearer|session)/i;

export function isSecretLikeKey(key: string): boolean {
  return SECRET_LIKE_RE.test(key);
}
