import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import type { SyncChange, SyncOperation } from "@uw/contracts";
import {
  createNote,
  createProject,
  loginOrSetup,
  newContext,
  openProject,
} from "./sync-helpers";

interface DeviceSummary {
  id: string;
  revokedAt: string | null;
}

async function listDevices(page: Page): Promise<DeviceSummary[]> {
  return page.evaluate(async () => {
    const response = await fetch("/api/sync/devices", {
      credentials: "include",
    });
    if (!response.ok) {
      throw new Error(`Unable to list devices: ${response.status}`);
    }
    const body = (await response.json()) as { devices?: DeviceSummary[] };
    return body.devices ?? [];
  });
}

async function latestDeviceId(page: Page): Promise<string> {
  const devices = await listDevices(page);
  const device = devices.at(-1);
  if (!device) throw new Error("No sync device registered");
  return device.id;
}

async function listChanges(page: Page): Promise<SyncChange[]> {
  return page.evaluate(async () => {
    const response = await fetch("/api/sync/changes?cursor=0&limit=500", {
      credentials: "include",
    });
    if (!response.ok) {
      throw new Error(`Unable to list sync changes: ${response.status}`);
    }
    const body = (await response.json()) as { changes?: SyncChange[] };
    return body.changes ?? [];
  });
}

async function pushOperation(
  page: Page,
  operation: SyncOperation,
): Promise<{ status: number; body: unknown }> {
  return page.evaluate(async (input) => {
    const response = await fetch("/api/sync/operations", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operations: [input] }),
    });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { status: response.status, body };
  }, operation);
}

function documentChangeByTitle(
  changes: SyncChange[],
  title: string,
): SyncChange | undefined {
  return changes.find((change) => {
    if (change.entityType !== "document" || change.kind !== "upsert") {
      return false;
    }
    const note = change.payload.note;
    if (typeof note !== "object" || note === null) return false;
    const document = (note as { document?: unknown }).document;
    return (
      typeof document === "object" &&
      document !== null &&
      (document as { title?: unknown }).title === title
    );
  });
}

test("server tombstone rejects an older offline update without resurrection", async ({
  browser,
}) => {
  const deletingContext = await newContext(browser);
  const deletingPage = await deletingContext.newPage();
  await loginOrSetup(deletingPage);
  await createProject(deletingPage, "Tombstone Project");
  await createNote(deletingPage, "Tombstone Note", "canonical body");
  await expect(deletingPage.getByLabel(/sync status/i)).toContainText("Synced");

  const deletingDeviceId = await latestDeviceId(deletingPage);
  const initialChanges = await listChanges(deletingPage);
  const created = documentChangeByTitle(initialChanges, "Tombstone Note");
  expect(created).toBeDefined();
  expect(created?.revision).toBeTruthy();

  const staleContext = await newContext(browser);
  const stalePage = await staleContext.newPage();
  await loginOrSetup(stalePage);
  await expect
    .poll(async () =>
      stalePage.getByRole("button", { name: "Tombstone Project" }).count(),
    )
    .toBe(1);
  await openProject(stalePage, "Tombstone Project");
  await stalePage.getByRole("button", { name: "Tombstone Note" }).click();
  await expect(stalePage.getByLabel(/note body/i)).toHaveValue(
    "canonical body",
  );

  const deleted = await pushOperation(deletingPage, {
    id: randomUUID(),
    deviceId: deletingDeviceId,
    projectId: created!.payload.note
      ? (
          created!.payload.note as {
            document: { projectId: string };
          }
        ).document.projectId
      : null,
    entityType: "document",
    entityId: created!.entityId,
    action: "document.delete",
    baseRevision: created!.revision,
    payload: {},
    createdAt: new Date().toISOString(),
  });
  expect(deleted.status).toBe(200);

  await stalePage.getByLabel(/note body/i).fill("stale offline resurrection");
  await stalePage.getByRole("button", { name: /save note/i }).click();

  await expect(stalePage.getByText(/sync conflict detected/i)).toBeVisible();
  await expect(stalePage.getByLabel(/note body/i)).toHaveValue(
    "stale offline resurrection",
  );

  const after = (await listChanges(deletingPage)).filter(
    (change) => change.entityId === created!.entityId,
  );
  const tombstoneIndex = after.findIndex(
    (change) => change.kind === "tombstone",
  );
  expect(tombstoneIndex).toBeGreaterThanOrEqual(0);
  expect(
    after.slice(tombstoneIndex + 1).some((change) => change.kind === "upsert"),
  ).toBe(false);
  expect(after.at(-1)?.kind).toBe("conflict");

  await deletingContext.close();
  await staleContext.close();
});

test("revoked device cannot push after reconnect", async ({ browser }) => {
  const revokedContext = await newContext(browser);
  const revokedPage = await revokedContext.newPage();
  await loginOrSetup(revokedPage);
  const revokedDeviceId = await latestDeviceId(revokedPage);

  const controlContext = await newContext(browser);
  const controlPage = await controlContext.newPage();
  await loginOrSetup(controlPage);

  const revokeStatus = await controlPage.evaluate(async (deviceId) => {
    const response = await fetch(`/api/sync/devices/${deviceId}`, {
      method: "DELETE",
      credentials: "include",
    });
    return response.status;
  }, revokedDeviceId);
  expect(revokeStatus).toBe(204);

  await revokedPage.reload();
  await createProject(revokedPage, "Revoked Device Local Project");
  await expect(revokedPage.getByLabel(/sync status/i)).toContainText("Offline");

  await expect
    .poll(async () => {
      const changes = await listChanges(controlPage);
      return changes.some((change) => {
        const project = change.payload.project;
        return (
          typeof project === "object" &&
          project !== null &&
          (project as { name?: unknown }).name ===
            "Revoked Device Local Project"
        );
      });
    })
    .toBe(false);

  const devices = await listDevices(controlPage);
  expect(
    devices.find((device) => device.id === revokedDeviceId)?.revokedAt,
  ).not.toBeNull();

  await revokedContext.close();
  await controlContext.close();
});
