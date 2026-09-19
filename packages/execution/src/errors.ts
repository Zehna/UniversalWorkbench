export class InvalidExecutionTransitionError extends Error {
  constructor(
    readonly from: string,
    readonly to: string,
  ) {
    super(`Invalid execution transition: ${from} -> ${to}`);
    this.name = "InvalidExecutionTransitionError";
  }
}
