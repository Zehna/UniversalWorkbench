import type {
  ContextType,
  ToolInputPort,
} from "@uw/contracts";
import { acceptsContext } from "./compatibility.js";

function adapterKey(from: ContextType, to: ContextType): string {
  return `${from}->${to}`;
}

export class ContextCompatibilityRegistry {
  readonly #adapters = new Set<string>();

  registerAdapter(from: ContextType, to: ContextType): void {
    this.#adapters.add(adapterKey(from, to));
  }

  canAdapt(from: ContextType, to: ContextType): boolean {
    return this.#adapters.has(adapterKey(from, to));
  }

  accepts(port: Pick<ToolInputPort, "types">, source: ContextType): boolean {
    if (acceptsContext(port, source)) return true;

    return port.types.some((target) => this.canAdapt(source, target));
  }
}
