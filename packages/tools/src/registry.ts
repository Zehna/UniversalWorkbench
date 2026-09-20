import {
  ToolDefinitionSchema,
  type ContextType,
  type ToolCapability,
  type ToolDefinition,
} from "@uw/contracts";
import { ContextCompatibilityRegistry } from "@uw/context";
import type {
  CompatibleToolTarget,
  RegisteredTool,
  ToolRunner,
} from "./contract.js";
import { DuplicateToolRegistrationError, ToolNotFoundError } from "./errors.js";

function registrationKey(id: string, version: string): string {
  return `${id}@${version}`;
}

export class ToolRegistry {
  readonly #tools = new Map<string, RegisteredTool>();

  constructor(
    readonly compatibility: ContextCompatibilityRegistry = new ContextCompatibilityRegistry(),
  ) {}

  register(definition: ToolDefinition, runner: ToolRunner): void {
    const parsedDefinition = ToolDefinitionSchema.parse(definition);
    const key = registrationKey(parsedDefinition.id, parsedDefinition.version);

    if (this.#tools.has(key)) {
      throw new DuplicateToolRegistrationError(
        parsedDefinition.id,
        parsedDefinition.version,
      );
    }

    this.#tools.set(key, {
      definition: parsedDefinition,
      runner,
    });
  }

  list(): ToolDefinition[] {
    return [...this.#tools.values()]
      .map((registered) => structuredClone(registered.definition))
      .sort(
        (left, right) =>
          left.id.localeCompare(right.id) ||
          left.version.localeCompare(right.version),
      );
  }

  resolve(id: string, version: string): RegisteredTool {
    const registered = this.#tools.get(registrationKey(id, version));
    if (!registered) {
      throw new ToolNotFoundError(id, version);
    }
    return registered;
  }

  compatibleTargets(type: ContextType): CompatibleToolTarget[] {
    const targets: CompatibleToolTarget[] = [];

    for (const registered of this.#tools.values()) {
      for (const inputPort of registered.definition.accepts) {
        if (this.compatibility.accepts(inputPort, type)) {
          targets.push({
            definition: registered.definition,
            inputPort,
          });
        }
      }
    }

    return targets;
  }

  requiredCapabilities(id: string, version: string): ToolCapability[] {
    return [...this.resolve(id, version).definition.requiredCapabilities];
  }
}
