import {
  expect,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";

export const E2E_OWNER = {
  username: "phase2-e2e-owner",
  password: "Phase2-e2e-password-2026!",
};

export async function loginOrSetup(page: Page): Promise<void> {
  await page.goto("/");

  const createOwner = page.getByRole("heading", { name: /create owner/i });
  const signIn = page.getByRole("heading", { name: /sign in/i });

  if (await createOwner.isVisible().catch(() => false)) {
    await page.getByLabel(/username/i).fill(E2E_OWNER.username);
    await page.getByLabel(/^password$/i).fill(E2E_OWNER.password);
    await page.getByRole("button", { name: /create owner/i }).click();
  } else {
    await expect(signIn).toBeVisible();
    await page.getByLabel(/username/i).fill(E2E_OWNER.username);
    await page.getByLabel(/^password$/i).fill(E2E_OWNER.password);
    await page.getByRole("button", { name: /sign in/i }).click();
  }

  await expect(page.getByRole("heading", { name: /projects/i })).toBeVisible();
}

export interface SyncGate {
  setBlocked(blocked: boolean): void;
}

export async function installSyncGate(
  context: BrowserContext,
  initiallyBlocked = true,
): Promise<SyncGate> {
  let blocked = initiallyBlocked;

  await context.route("**/api/sync/**", async (route) => {
    if (blocked) {
      await route.abort("internetdisconnected");
      return;
    }
    await route.continue();
  });

  await context.routeWebSocket("**/api/sync/socket", (socket) => {
    if (blocked) {
      socket.close({ code: 1013, reason: "e2e offline" });
      return;
    }
    socket.connectToServer();
  });

  return {
    setBlocked(next) {
      blocked = next;
    },
  };
}

export async function newContext(
  browser: Browser,
  options: Parameters<Browser["newContext"]>[0] = {},
): Promise<BrowserContext> {
  return browser.newContext({
    baseURL: "http://127.0.0.1:4173",
    ...options,
  });
}

export async function createProject(page: Page, name: string): Promise<void> {
  await page.getByLabel(/project name/i).fill(name);
  await page.getByRole("button", { name: /create project/i }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
}

export async function createNote(
  page: Page,
  title: string,
  body: string,
): Promise<void> {
  await page.getByRole("button", { name: /new note/i }).click();
  await page.getByLabel(/note title/i).fill(title);
  await page.getByLabel(/note body/i).fill(body);
  await page.getByRole("button", { name: /save note/i }).click();
  await expect(page.getByRole("button", { name: title })).toBeVisible();
}

export async function openProject(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
}
