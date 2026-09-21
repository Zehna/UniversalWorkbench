import type { JsonObject, JsonValue } from "./context.js";
import type { ToolDefinition } from "./tool.js";

export interface ToolConfigValidationIssue {
  path: string;
  message: string;
}

export type ToolConfigValidationResult =
  | { ok: true; issues: [] }
  | { ok: false; issues: ToolConfigValidationIssue[] };

function sameJsonValue(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => sameJsonValue(item, right[index]!))
    );
  }
  if (
    typeof left !== "object" ||
    left === null ||
    typeof right !== "object" ||
    right === null
  ) {
    return false;
  }

  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        sameJsonValue(left[key]!, right[key]!),
    )
  );
}

function asObject(value: JsonValue | undefined): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function schemaType(schema: JsonObject): string | undefined {
  return typeof schema.type === "string" ? schema.type : undefined;
}

function childPath(path: string, key: string): string {
  return path === "$" ? `$.${key}` : `${path}.${key}`;
}

function validateValue(
  value: JsonValue,
  schema: JsonObject,
  path: string,
  issues: ToolConfigValidationIssue[],
): void {
  const enumValues = Array.isArray(schema.enum) ? schema.enum : undefined;
  if (
    enumValues &&
    !enumValues.some((candidate) => sameJsonValue(candidate, value))
  ) {
    issues.push({ path, message: "value is not in the allowed enum" });
    return;
  }

  const type = schemaType(schema);
  if (!type) return;

  if (type === "string") {
    if (typeof value !== "string") {
      issues.push({ path, message: "expected string" });
      return;
    }
    if (
      typeof schema.minLength === "number" &&
      value.length < schema.minLength
    ) {
      issues.push({ path, message: `minimum length is ${schema.minLength}` });
    }
    if (
      typeof schema.maxLength === "number" &&
      value.length > schema.maxLength
    ) {
      issues.push({ path, message: `maximum length is ${schema.maxLength}` });
    }
    return;
  }

  if (type === "number" || type === "integer") {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      (type === "integer" && !Number.isInteger(value))
    ) {
      issues.push({ path, message: `expected ${type}` });
    }
    return;
  }

  if (type === "boolean") {
    if (typeof value !== "boolean") {
      issues.push({ path, message: "expected boolean" });
    }
    return;
  }

  if (type === "null") {
    if (value !== null) issues.push({ path, message: "expected null" });
    return;
  }

  if (type === "array") {
    if (!Array.isArray(value)) {
      issues.push({ path, message: "expected array" });
      return;
    }
    const itemSchema = asObject(schema.items);
    if (itemSchema) {
      value.forEach((item, index) =>
        validateValue(item, itemSchema, `${path}[${index}]`, issues),
      );
    }
    return;
  }

  if (type !== "object") {
    issues.push({ path, message: `unsupported schema type ${type}` });
    return;
  }

  const object = asObject(value);
  if (!object) {
    issues.push({ path, message: "expected object" });
    return;
  }

  const required = Array.isArray(schema.required)
    ? schema.required.filter(
        (item): item is string => typeof item === "string",
      )
    : [];
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(object, key)) {
      issues.push({
        path: childPath(path, key),
        message: "required property is missing",
      });
    }
  }

  const properties = asObject(schema.properties) ?? {};
  const additional = schema.additionalProperties;
  for (const [key, entry] of Object.entries(object)) {
    const propertySchema = asObject(properties[key]);
    if (propertySchema) {
      validateValue(entry, propertySchema, childPath(path, key), issues);
      continue;
    }

    if (additional === false) {
      issues.push({
        path: childPath(path, key),
        message: "additional property is not allowed",
      });
      continue;
    }

    const additionalSchema = asObject(additional);
    if (additionalSchema) {
      validateValue(entry, additionalSchema, childPath(path, key), issues);
    }
  }
}

export function validateToolConfig(
  definition: Pick<ToolDefinition, "configSchema">,
  config: JsonObject,
): ToolConfigValidationResult {
  if (Object.keys(definition.configSchema).length === 0) {
    return { ok: true, issues: [] };
  }

  const issues: ToolConfigValidationIssue[] = [];
  validateValue(config, definition.configSchema, "$", issues);
  return issues.length === 0
    ? { ok: true, issues: [] }
    : { ok: false, issues };
}
