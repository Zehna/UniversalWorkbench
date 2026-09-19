import { expect, test } from "@playwright/test";
import {
  createProject,
  installSyncGate,
  loginOrSetup,
  newContext,
} from "./sync-helpers";

test("IndexedDB fallback preserves pending operations across reload", async ({
  browser,
}) => {
  const context = await newContext(browser);
  await context.addInitScript(() => {
    if (navigator.storage) {
      Object.defineProperty(navigator.storage, "getDirectory", {
        configurable: true,
        value: undefined,
      });
    }
  });
  await installSyncGate(context, true);

  const page = await context.newPage();
  await loginOrSetup(page);
  await createProject(page, "IndexedDB Pending");

  await expect(page.getByLabel(/sync status/i)).toContainText("pending");
  await page.reload();

  await expect(
    page.getByRole("button", { name: "IndexedDB Pending" }),
  ).toBeVisible();
  await expect(page.getByLabel(/sync status/i)).toContainText("pending");

  await context.close();
});
