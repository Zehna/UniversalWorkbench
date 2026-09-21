import { describe, expect, it } from "vitest";
import {
  canTransitionExecution,
  canTransitionStep,
  isTerminalExecutionStatus,
} from "../src/index.js";

describe("Phase 3 execution model", () => {
  it("allows only forward execution lifecycle transitions", () => {
    expect(canTransitionExecution("queued", "running")).toBe(true);
    expect(canTransitionExecution("queued", "cancelled")).toBe(true);
    expect(canTransitionExecution("running", "succeeded")).toBe(true);
    expect(canTransitionExecution("running", "failed")).toBe(true);
    expect(canTransitionExecution("running", "cancelled")).toBe(true);
    expect(canTransitionExecution("running", "timed_out")).toBe(true);

    expect(canTransitionExecution("succeeded", "running")).toBe(false);
    expect(canTransitionExecution("cancelled", "queued")).toBe(false);
    expect(canTransitionExecution("failed", "running")).toBe(false);
    expect(canTransitionExecution("timed_out", "running")).toBe(false);
  });

  it("treats every final execution status as terminal", () => {
    expect(isTerminalExecutionStatus("queued")).toBe(false);
    expect(isTerminalExecutionStatus("running")).toBe(false);
    expect(isTerminalExecutionStatus("succeeded")).toBe(true);
    expect(isTerminalExecutionStatus("failed")).toBe(true);
    expect(isTerminalExecutionStatus("cancelled")).toBe(true);
    expect(isTerminalExecutionStatus("timed_out")).toBe(true);
  });

  it("does not allow terminal step states to become runnable again", () => {
    expect(canTransitionStep("pending", "queued")).toBe(true);
    expect(canTransitionStep("queued", "running")).toBe(true);
    expect(canTransitionStep("queued", "skipped")).toBe(true);
    expect(canTransitionStep("running", "running")).toBe(true);
    expect(canTransitionStep("running", "succeeded")).toBe(true);
    expect(canTransitionStep("pending", "skipped")).toBe(true);

    for (const terminal of [
      "succeeded",
      "failed",
      "skipped",
      "cancelled",
      "timed_out",
    ] as const) {
      expect(canTransitionStep(terminal, "queued")).toBe(false);
      expect(canTransitionStep(terminal, "running")).toBe(false);
    }
  });
});
