import { describe, expect, it } from "vitest";
import {
  ClientSyncMessageSchema,
  INITIAL_SYNC_CURSOR,
  SyncOperationSchema,
  compareSyncCursors,
} from "../src/index.js";

function validOperation() {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    deviceId: "22222222-2222-4222-8222-222222222222",
    projectId: "33333333-3333-4333-8333-333333333333",
    entityType: "project" as const,
    entityId: "33333333-3333-4333-8333-333333333333",
    action: "project.create" as const,
    baseRevision: null,
    payload: { name: "Offline" },
    createdAt: "2026-09-18T12:00:00.000Z",
  };
}

describe("@uw/sync boundary", () => {
  it("reuses the runtime operation contract", () => {
    expect(SyncOperationSchema.parse(validOperation())).toEqual(
      validOperation(),
    );
  });

  it("reuses the WebSocket client message contract", () => {
    const message = {
      type: "PUSH_OPERATION" as const,
      operation: validOperation(),
    };
    expect(ClientSyncMessageSchema.parse(message)).toEqual(message);
  });

  it("uses zero as the initial cursor", () => {
    expect(INITIAL_SYNC_CURSOR).toBe("0");
  });

  it("compares decimal cursors numerically rather than lexicographically", () => {
    expect(compareSyncCursors("9", "10")).toBe(-1);
    expect(compareSyncCursors("10", "10")).toBe(0);
    expect(compareSyncCursors("11", "10")).toBe(1);
  });
});
