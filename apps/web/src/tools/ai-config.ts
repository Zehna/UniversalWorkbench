const SECRET_REF_RE =
  /^secret:\/\/(vault|local)\/([a-z0-9][a-z0-9._-]{0,127})$/;

export function isSecretRef(value: unknown): boolean {
  return typeof value === "string" && SECRET_REF_RE.test(value.trim());
}

/** Device-only refs the server can never resolve. */
export function isLocalSecretRef(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const match = SECRET_REF_RE.exec(value.trim());
  return match?.[1] === "local";
}

export interface AiToolConfigInput {
  providerId?: unknown;
  model?: unknown;
  prompt?: unknown;
  systemPrompt?: unknown;
  secretRef?: unknown;
  responseFormat?: unknown;
  maxOutputTokens?: unknown;
}

/**
 * Client-side validation mirroring the server `AiToolConfig` contract.
 * Returns blocking error strings (empty when valid). A `secret://local/*`
 * ref is valid but device-only — see `isLocalSecretRef` for the warning.
 */
export function validateAiToolConfig(config: AiToolConfigInput): string[] {
  const errors: string[] = [];
  if (
    typeof config.providerId !== "string" ||
    config.providerId.trim().length === 0
  ) {
    errors.push("Choose an AI provider.");
  }
  if (
    typeof config.model !== "string" ||
    config.model.trim().length === 0 ||
    config.model.trim().length > 256
  ) {
    errors.push("Enter a model name (1–256 characters).");
  }
  if (
    typeof config.prompt !== "string" ||
    config.prompt.trim().length === 0 ||
    config.prompt.length > 100_000
  ) {
    errors.push("Enter a prompt (1–100,000 characters).");
  }
  if (!isSecretRef(config.secretRef)) {
    errors.push(
      "Enter a secret reference like secret://vault/openai or secret://local/key.",
    );
  }
  const format = config.responseFormat;
  if (format !== undefined) {
    if (
      format === null ||
      typeof format !== "object" ||
      Array.isArray(format)
    ) {
      errors.push("Response format must be text or JSON.");
    } else {
      const kind = (format as { kind?: unknown }).kind;
      if (kind !== "text" && kind !== "json") {
        errors.push("Response format must be text or JSON.");
      }
      if (kind === "json") {
        const schema = (format as { jsonSchema?: unknown }).jsonSchema;
        if (typeof schema === "string") {
          try {
            const parsed: unknown = JSON.parse(schema);
            if (
              typeof parsed !== "object" ||
              parsed === null ||
              Array.isArray(parsed)
            ) {
              errors.push("JSON schema must be a JSON object.");
            }
          } catch {
            errors.push("JSON schema must be valid JSON.");
          }
        } else if (
          typeof schema !== "object" ||
          schema === null ||
          Array.isArray(schema)
        ) {
          errors.push("JSON responses need a schema object.");
        }
      }
    }
  }
  if (config.maxOutputTokens !== undefined) {
    const max =
      typeof config.maxOutputTokens === "string"
        ? Number(config.maxOutputTokens)
        : config.maxOutputTokens;
    if (
      typeof max !== "number" ||
      !Number.isInteger(max) ||
      max < 1 ||
      max > 128_000
    ) {
      errors.push("Max output tokens must be 1–128,000.");
    }
  }
  return errors;
}

/** Normalize the editor's schema textarea into a schema object or undefined. */
export function parseJsonSchemaInput(value: unknown): {
  schema?: Record<string, unknown>;
  error?: string;
} {
  if (value === undefined || value === null || value === "") return {};
  if (typeof value !== "string") {
    return typeof value === "object" && !Array.isArray(value)
      ? { schema: value as Record<string, unknown> }
      : { error: "JSON schema must be a JSON object." };
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return { error: "JSON schema must be a JSON object." };
    }
    return { schema: parsed as Record<string, unknown> };
  } catch {
    return { error: "JSON schema must be valid JSON." };
  }
}

export interface AiAgentConfigInput {
  providerId?: unknown;
  model?: unknown;
  prompt?: unknown;
  systemPrompt?: unknown;
  secretRef?: unknown;
  allowedTools?: unknown;
  maxIterations?: unknown;
  maxOutputTokens?: unknown;
}

/**
 * Client-side validation mirroring `AiAgentConfigSchema`.
 * Returns blocking error strings (empty when valid).
 */
export function validateAiAgentConfig(config: AiAgentConfigInput): string[] {
  const errors: string[] = [];
  if (
    typeof config.providerId !== "string" ||
    config.providerId.trim().length === 0
  ) {
    errors.push("Choose an AI provider.");
  }
  if (
    typeof config.model !== "string" ||
    config.model.trim().length === 0 ||
    config.model.trim().length > 256
  ) {
    errors.push("Enter a model name (1–256 characters).");
  }
  if (
    typeof config.prompt !== "string" ||
    config.prompt.trim().length === 0 ||
    config.prompt.length > 100_000
  ) {
    errors.push("Enter a prompt (1–100,000 characters).");
  }
  if (!isSecretRef(config.secretRef)) {
    errors.push(
      "Enter a secret reference like secret://vault/openai or secret://local/key.",
    );
  }
  if (config.maxIterations !== undefined) {
    const max =
      typeof config.maxIterations === "string"
        ? Number(config.maxIterations)
        : config.maxIterations;
    if (
      typeof max !== "number" ||
      !Number.isInteger(max) ||
      max < 1 ||
      max > 15
    ) {
      errors.push("Max iterations must be 1–15.");
    }
  }
  if (config.allowedTools !== undefined) {
    if (
      !Array.isArray(config.allowedTools) ||
      !config.allowedTools.every(
        (item): item is string =>
          typeof item === "string" &&
          item.trim().length >= 1 &&
          item.trim().length <= 128,
      )
    ) {
      errors.push("Allowed tools must be a list of tool IDs.");
    }
  }
  if (config.maxOutputTokens !== undefined) {
    const max =
      typeof config.maxOutputTokens === "string"
        ? Number(config.maxOutputTokens)
        : config.maxOutputTokens;
    if (
      typeof max !== "number" ||
      !Number.isInteger(max) ||
      max < 1 ||
      max > 128_000
    ) {
      errors.push("Max output tokens must be 1–128,000.");
    }
  }
  return errors;
}
