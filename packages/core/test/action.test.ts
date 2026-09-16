import { describe, expect, it, vi } from "vitest";
import { executeAction } from "../src/action.js";

describe("executeAction", () => {
  it("authorizes before mutation and audits a successful result", async () => {
    const order: string[] = [];
    const authorize = vi.fn(async () => {
      order.push("authorize");
    });
    const run = vi.fn(async () => {
      order.push("run");
      return { id: "result-1" };
    });
    const audit = vi.fn(async () => {
      order.push("audit");
    });

    const result = await executeAction({
      name: "project.create",
      input: { name: "History" },
      context: { actorId: "actor-1", traceId: "trace-1" },
      authorize,
      run,
      audit,
    });

    expect(result).toEqual({ id: "result-1" });
    expect(order).toEqual(["authorize", "run", "audit"]);
  });

  it("does not mutate or audit when authorization is denied", async () => {
    const denied = new Error("denied");
    const run = vi.fn(async () => ({ id: "never" }));
    const audit = vi.fn(async () => undefined);

    await expect(
      executeAction({
        name: "project.update",
        input: {},
        context: { actorId: "actor-2", traceId: "trace-2" },
        authorize: async () => {
          throw denied;
        },
        run,
        audit,
      }),
    ).rejects.toBe(denied);

    expect(run).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("does not emit a success audit when mutation fails", async () => {
    const failed = new Error("mutation failed");
    const audit = vi.fn(async () => undefined);

    await expect(
      executeAction({
        name: "project.update",
        input: {},
        context: { actorId: "actor-3", traceId: "trace-3" },
        authorize: async () => undefined,
        run: async () => {
          throw failed;
        },
        audit,
      }),
    ).rejects.toBe(failed);

    expect(audit).not.toHaveBeenCalled();
  });
});
