import { expect, test } from "@playwright/test";
import { createProject, loginOrSetup, newContext } from "./sync-helpers";

test("creates and runs HTTP to JSON extraction against a deterministic in-stack fixture", async ({
  browser,
}) => {
  const context = await newContext(browser, {
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  try {
    await loginOrSetup(page);
    await createProject(page, "Phase 3 Workflow E2E");
    await expect(page.getByLabel(/sync status/i)).toContainText("Synced", {
      timeout: 30_000,
    });

    await page.getByRole("tab", { name: "Workflows" }).click();
    await expect(
      page.getByRole("heading", { name: "Workflows" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "New workflow" }).click();
    await page.getByLabel("Workflow name").fill("Fixture HTTP JSON");
    await page
      .getByLabel("Compatible tool")
      .selectOption("builtin.http.request@1.0.0");
    await page.getByRole("button", { name: "Add Step" }).click();
    await page
      .getByLabel("Request URL")
      .fill("https://fixture.workbench.dev/response");

    await page
      .getByLabel("Compatible tool")
      .selectOption("builtin.json.extract@1.0.0");
    await page.getByRole("button", { name: "Add Step" }).click();
    await page.getByLabel("JSON path").fill("answer");
    await page.getByRole("button", { name: "Save workflow" }).click();
    await expect(
      page.getByRole("button", { name: "Run workflow" }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Run workflow" }).click();
    await expect(page.getByText("Network: Required")).toBeVisible();
    await expect(page.getByText(/Preflight ready/)).toBeVisible();
    await page.getByRole("button", { name: "Run workflow" }).click();
    await expect(page.getByText("Status: completed")).toBeVisible({
      timeout: 40_000,
    });
    await expect(page.getByText("42", { exact: true })).toBeVisible();
    await page
      .getByRole("button", { name: "Save output as Artifact" })
      .last()
      .click();
    await expect(page.getByText(/Artifact saved:/)).toBeVisible();
  } finally {
    await context.close();
  }
});
