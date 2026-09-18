import { expect, test } from "@playwright/test";

test("persists local project state across page reload using OPFS", async ({
  page,
}) => {
  await page.goto("/__phase2-test");

  await page.evaluate(() => {
    const phase2 = (
      window as Window & {
        __phase2?: {
          createProjectOffline(name: string): Promise<void>;
          projectNames(): Promise<string[]>;
        };
      }
    ).__phase2;

    if (!phase2) throw new Error("Phase 2 local test bridge is unavailable");
    return phase2.createProjectOffline("Offline");
  });

  await page.reload();

  await expect
    .poll(() =>
      page.evaluate(async () => {
        const phase2 = (
          window as Window & {
            __phase2?: {
              projectNames(): Promise<string[]>;
            };
          }
        ).__phase2;

        if (!phase2) throw new Error("Phase 2 local test bridge is unavailable");
        return phase2.projectNames();
      }),
    )
    .toContain("Offline");
});
