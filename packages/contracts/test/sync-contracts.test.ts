import { describe, expect, it } from "vitest";
import {
  ClientSyncMessageSchema,
  ServerSyncMessageSchema,
  SyncChangeSchema,
  SyncOperationSchema,
} from "../src/index.js";

const OPERATION_ID = "11111111-1111-4111-8111-111111111111";
const DEVICE_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const ENTITY_ID = "44444444-4444-4444-8444-444444444444";
const NOW = "2026-09-18T00:00:00.000Z";

function validOperation() {
  return {
    id: OPERATION_ID,
    deviceId: DEVICE_ID,
    projectId: PROJECT_ID,
    entityType: "project" as const,
    entityId: ENTITY_ID,
    action: "project.create" as const,
    baseRevision: null,
    payload: { name: "Offline project" },
    createdAt: NOW,
  };
}

describe("phase 2 sync contracts", () => {
  it("rejects a sync operation without a device ID", () => {
    expect(
      SyncOperationSchema.safeParse({
        ...validOperation(),
        deviceId: "",
      }).success,
    ).toBe(false);
  });

  it("accepts a valid pending sync operation", () => {
    expect(SyncOperationSchema.parse(validOperation())).toEqual(validOperation());
  });

  it("round-trips client WebSocket messages through a discriminated union", () => {
    const message = {
      type: "PUSH_OPERATION" as const,
      operation: validOperation(),
    };

    expect(ClientSyncMessageSchema.parse(message)).toEqual(message);
  });

  it("requires decimal-string cursors on server messages", () => {
    const valid = {
      type: "READY" as const,
      deviceId: DEVICE_ID,
      cursor: "42",
    };

    expect(ServerSyncMessageSchema.parse(valid)).toEqual(valid);
    expect(
      ServerSyncMessageSchema.safeParse({ ...valid, cursor: "4.2" }).success,
    ).toBe(false);
  });

  it("validates conflict changes without losing structured payloads", () => {
    const change = {
      cursor: "43",
      operationId: OPERATION_ID,
      entityType: "document" as const,
      entityId: ENTITY_ID,
      kind: "conflict" as const,
      revision: "55555555-5555-4555-8555-555555555555",
      payload: {
        incoming: { body: "offline" },
        current: { body: "server" },
      },
      createdAt: NOW,
    };

    expect(SyncChangeSchema.parse(change)).toEqual(change);
  });
});
