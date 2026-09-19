export class ToolRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolRegistryError";
  }
}

export class DuplicateToolRegistrationError extends ToolRegistryError {
  constructor(
    readonly toolId: string,
    readonly toolVersion: string,
  ) {
    super(`Tool ${toolId}@${toolVersion} is already registered`);
    this.name = "DuplicateToolRegistrationError";
  }
}

export class ToolNotFoundError extends ToolRegistryError {
  constructor(
    readonly toolId: string,
    readonly toolVersion: string,
  ) {
    super(`Tool ${toolId}@${toolVersion} is not registered`);
    this.name = "ToolNotFoundError";
  }
}
