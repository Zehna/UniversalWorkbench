import { describe, expect, it } from "vitest";
import { ToolExecutionError } from "@uw/tools";
import { sanitizeExecutionError } from "../src/errors.js";

describe("execution error sanitization", () => {
  it("preserves trusted structured tool error codes without exposing unknown errors", () => {
    expect(
      sanitizeExecutionError(
        new ToolExecutionError({
          code: "UNSAFE_EGRESS",
          message: "Destination is blocked",
          details: { policy: "public-only" },
          retrySafe: false,
        }),
      ),
    ).toEqual({
      code: "UNSAFE_EGRESS",
      message: "Destination is blocked",
      details: { policy: "public-only" },
    });

    expect(sanitizeExecutionError(new Error("secret internal detail"))).toEqual({
      code: "TOOL_BUG",
      message: "Tool execution failed",
    });
  });
});
