import { expect, test } from "@playwright/test";
import {
  createNote,
  createProject,
  installSyncGate,
  loginOrSetup,
  newContext,
  openProject,
} from "./sync-helpers";

test.describe.serial("Phase 2 multi-device sync", () => {
  test("offline note edit syncs to a second device after reconnect", async ({
    browser,
  }) => {
    const phone = await newContext(browser);
    const gate = await installSyncGate(phone, true);
    const phonePage = await phone.newPage();
    await loginOrSetup(phonePage);

    await expect(phonePage.getByLabel(/sync status/i)).toContainText("Offline");
    await createProject(phonePage, "Reconnect Project");
    await createNote(phonePage, "Offline Note", "written without network");
    await expect(phonePage.getByLabel(/sync status/i)).toContainText("pending");

    const laptop = await newContext(browser);
    const laptopPage = await laptop.newPage();
    await loginOrSetup(laptopPage);

    gate.setBlocked(false);
    await phonePage.reload();
    await expect(phonePage.getByLabel(/sync status/i)).toContainText("Synced");

    await expect
      .poll(async () =>
        laptopPage.getByRole("button", { name: "Reconnect Project" }).count(),
      )
      .toBe(1);

    await openProject(laptopPage, "Reconnect Project");
    await expect(
      laptopPage.getByRole("button", { name: "Offline Note" }),
    ).toBeVisible();

    await phone.close();
    await laptop.close();
  });
});
