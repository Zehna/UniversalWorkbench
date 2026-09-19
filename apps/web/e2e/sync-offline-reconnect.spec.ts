import { expect, test } from "@playwright/test";
import {
  createNote,
  createProject,
  installSyncGate,
  loginOrSetup,
  newContext,
} from "./sync-helpers";

test("offline edit drains after reconnect without losing local text", async ({
  browser,
}) => {
  const context = await newContext(browser);
  const page = await context.newPage();
  await loginOrSetup(page);

  await createProject(page, "Reconnect Edit Project");
  await createNote(page, "Reconnect Edit Note", "first");
  await expect(page.getByLabel(/sync status/i)).toContainText("Synced");

  await page.getByRole("button", { name: "Reconnect Edit Note" }).click();

  const gate = await installSyncGate(context, true);
  await page.reload();
  await page.getByRole("button", { name: "Reconnect Edit Project" }).click();
  await page.getByRole("button", { name: "Reconnect Edit Note" }).click();

  await page.getByLabel(/note body/i).fill("offline revision");
  await page.getByRole("button", { name: /save note/i }).click();
  await expect(page.getByLabel(/note body/i)).toHaveValue("offline revision");
  await expect(page.getByLabel(/sync status/i)).toContainText("Offline");

  gate.setBlocked(false);
  await page.reload();
  await expect(page.getByLabel(/sync status/i)).toContainText("Synced");

  await page.getByRole("button", { name: "Reconnect Edit Project" }).click();
  await page.getByRole("button", { name: "Reconnect Edit Note" }).click();
  await expect(page.getByLabel(/note body/i)).toHaveValue("offline revision");

  await context.close();
});
