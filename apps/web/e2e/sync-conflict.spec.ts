import { expect, test } from "@playwright/test";
import {
  createNote,
  createProject,
  loginOrSetup,
  newContext,
  openProject,
} from "./sync-helpers";

test("concurrent device edits preserve the stale local version as a conflict", async ({
  browser,
}) => {
  const first = await newContext(browser);
  const firstPage = await first.newPage();
  await loginOrSetup(firstPage);
  await createProject(firstPage, "Conflict Project");
  await createNote(firstPage, "Shared Note", "base");
  await expect(firstPage.getByLabel(/sync status/i)).toContainText("Synced");

  const second = await newContext(browser);
  const secondPage = await second.newPage();
  await loginOrSetup(secondPage);

  await expect
    .poll(async () =>
      secondPage.getByRole("button", { name: "Conflict Project" }).count(),
    )
    .toBe(1);
  await openProject(secondPage, "Conflict Project");
  await secondPage.getByRole("button", { name: "Shared Note" }).click();
  await expect(secondPage.getByLabel(/note body/i)).toHaveValue("base");

  await firstPage.getByRole("button", { name: "Shared Note" }).click();
  await firstPage.getByLabel(/note body/i).fill("first device edit");
  await firstPage.getByRole("button", { name: /save note/i }).click();
  await expect(firstPage.getByLabel(/sync status/i)).toContainText("Synced");

  await secondPage.getByLabel(/note body/i).fill("second device local edit");
  await secondPage.getByRole("button", { name: /save note/i }).click();

  await expect(secondPage.getByText(/sync conflict detected/i)).toBeVisible();
  await expect(secondPage.getByLabel(/note body/i)).toHaveValue(
    "second device local edit",
  );
  await expect(secondPage.getByLabel(/sync status/i)).toContainText("Conflict");

  await secondPage.getByRole("button", { name: /use server version/i }).click();
  await expect(secondPage.getByLabel(/note body/i)).toHaveValue(
    "first device edit",
  );

  await first.close();
  await second.close();
});
