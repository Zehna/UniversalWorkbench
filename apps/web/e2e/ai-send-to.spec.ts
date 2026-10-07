import { expect, test } from "@playwright/test";
import {
  createProject,
  loginOrSetup,
  newContext,
  openProject,
} from "./sync-helpers";

test.describe.serial("Phase 4 AI send-to flow across two devices", () => {
  test("HTTP -> JSON -> AI(mock) -> Note syncs; second device saves Artifact", async ({
    browser,
  }) => {
    const runId = Date.now().toString(36);
    const projectName = `AI E2E ${runId}`;
    const secretName = `e2e-ai-${runId}`;
    const model = "e2e-model";

    const deviceA = await newContext(browser, {
      viewport: { width: 390, height: 844 },
    });
    const pageA = await deviceA.newPage();
    try {
      await loginOrSetup(pageA);
      await createProject(pageA, projectName);
      await expect(pageA.getByLabel(/sync status/i)).toContainText("Synced", {
        timeout: 30_000,
      });

      // Seed a vault secret for this run (server keyring is ephemeral per
      // stack start; names are run-unique).
      const seed = await pageA.evaluate(
        async ({ name }: { name: string }) => {
          const response = await fetch(
            `/api/vault/${encodeURIComponent(name)}`,
            {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ value: `e2e-canary-${name}` }),
            },
          );
          return { status: response.status };
        },
        { name: secretName },
      );
      expect(seed.status).toBe(200);

      await pageA.getByRole("tab", { name: "Workflows" }).click();
      await pageA.getByRole("button", { name: "New workflow" }).click();
      await pageA.getByLabel("Workflow name").fill("AI golden flow");
      await pageA
        .getByLabel("Compatible tool")
        .selectOption("builtin.http.request@1.0.0");
      await pageA.getByRole("button", { name: "Add Step" }).click();
      await pageA
        .getByLabel("Request URL")
        .fill("https://fixture.workbench.dev/response");

      await pageA
        .getByLabel("Compatible tool")
        .selectOption("builtin.json.extract@1.0.0");
      await pageA.getByRole("button", { name: "Add Step" }).click();
      await pageA.getByLabel("JSON path").fill("answer");

      await pageA
        .getByLabel("Compatible tool")
        .selectOption("builtin.ai.complete@1.0.0");
      await pageA.getByRole("button", { name: "Add Step" }).click();
      await pageA.getByLabel("AI provider").fill("mock");
      await pageA.getByLabel("AI model").fill(model);
      await pageA.getByLabel("AI prompt").fill("Summarize the answer:");
      await pageA
        .getByLabel("Secret reference")
        .fill(`secret://vault/${secretName}`);
      await pageA.getByRole("button", { name: "Save workflow" }).click();
      await expect(
        pageA.getByRole("button", { name: "Run workflow" }),
      ).toBeVisible();

      await pageA.getByRole("button", { name: "Run workflow" }).click();
      await expect(pageA.getByText("Network: Required")).toBeVisible();
      await expect(pageA.getByText("AI: Required")).toBeVisible();
      await expect(pageA.getByText(/token budget/i)).toBeVisible();
      await expect(pageA.getByText(/Preflight ready/)).toBeVisible();
      await pageA.getByRole("button", { name: "Run workflow" }).click();
      await expect(pageA.getByText("Status: completed")).toBeVisible({
        timeout: 60_000,
      });
      await expect(pageA.getByText(/total:.*tokens/i)).toBeVisible();
      await expect(pageA.getByText(/\(estimated\)/).first()).toBeVisible();

      const expectedText = `mock:${model}:`;
      await expect(pageA.getByText(expectedText)).toBeVisible();
      // The AI output is the last workflow output; earlier outputs (HTTP,
      // JSON) have their own save buttons.
      await pageA.getByRole("button", { name: "Save as Note" }).last().click();
      await expect(pageA.getByText(/note saved/i)).toBeVisible({
        timeout: 30_000,
      });
      await expect(pageA.getByLabel(/sync status/i)).toContainText("Synced", {
        timeout: 30_000,
      });

      const deviceB = await browser.newContext({
        baseURL: "http://127.0.0.1:4173",
        viewport: { width: 390, height: 844 },
      });
      const pageB = await deviceB.newPage();
      try {
        await loginOrSetup(pageB);
        await expect
          .poll(
            async () =>
              pageB.getByRole("button", { name: projectName }).count(),
            { timeout: 30_000 },
          )
          .toBe(1);
        await openProject(pageB, projectName);
        await expect(
          pageB.getByRole("button", { name: "AI result" }).first(),
        ).toBeVisible({ timeout: 30_000 });
        await pageB.getByRole("button", { name: "AI result" }).first().click();
        await expect(pageB.getByText(expectedText)).toBeVisible();

        // Deterministic mock output is byte-identical on re-run: run the same
        // saved workflow and save its AI output as an Artifact.
        await pageB.getByRole("tab", { name: "Workflows" }).click();
        await expect(
          pageB.getByRole("heading", { name: "Workflows" }),
        ).toBeVisible();
        await pageB
          .getByRole("button", { name: /run ai golden flow/i })
          .click();
        await expect(pageB.getByText(/Preflight ready/)).toBeVisible();
        await pageB.getByRole("button", { name: "Run workflow" }).click();
        await expect(pageB.getByText("Status: completed")).toBeVisible({
          timeout: 60_000,
        });
        await pageB
          .getByRole("button", { name: "Save output as Artifact" })
          .last()
          .click();
        await expect(pageB.getByText(/artifact saved:/i)).toBeVisible({
          timeout: 30_000,
        });
      } finally {
        await deviceB.close();
      }
    } finally {
      await deviceA.close();
    }
  });
});
