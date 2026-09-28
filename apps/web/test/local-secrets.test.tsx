import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function loadModule() {
  return import("../src/secrets/local-secrets");
}

const OWNER_A = "owner-a-11111111-1111-4111-8111-111111111111";
const OWNER_B = "owner-b-22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  vi.restoreAllMocks();
  // Clear in-memory fallback between tests to keep isolation explicit.
  const g = globalThis as Record<string, unknown>;
  delete g.__uwLocalSecretsFallback;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("LocalSecretStore", () => {
  it("put/list/get/remove round-trip", async () => {
    const { createLocalSecretStore } = await loadModule();
    const store = createLocalSecretStore(OWNER_A);
    await store.put("openai-key", "sk-test-value-123");
    await expect(store.list()).resolves.toEqual(["openai-key"]);
    await expect(store.get("openai-key")).resolves.toBe("sk-test-value-123");
    await store.remove("openai-key");
    await expect(store.list()).resolves.toEqual([]);
    await expect(store.get("openai-key")).resolves.toBeNull();
  });

  it("persists across reload (new store instance, same owner)", async () => {
    const { createLocalSecretStore } = await loadModule();
    const first = createLocalSecretStore(OWNER_A);
    await first.put("persist-me", "persist-value-xyz");
    const second = createLocalSecretStore(OWNER_A);
    await expect(second.get("persist-me")).resolves.toBe("persist-value-xyz");
    await expect(second.list()).resolves.toEqual(["persist-me"]);
  });

  it("rejects invalid names without duplicating SecretRef regex", async () => {
    const { createLocalSecretStore } = await loadModule();
    const store = createLocalSecretStore(OWNER_A);
    for (const bad of [
      "",
      "UPPER",
      "../escape",
      "has space",
      "secret://local/x".slice(0, 0) || "",
    ]) {
      if (bad === "") {
        await expect(store.put(bad, "v")).rejects.toThrow();
      }
    }
    await expect(store.put("UPPER", "v")).rejects.toThrow();
    await expect(store.put("../escape", "v")).rejects.toThrow();
    await expect(store.put("has space", "v")).rejects.toThrow();
    await expect(store.put("a".repeat(200), "v")).rejects.toThrow();
    await expect(store.get("UPPER")).rejects.toThrow();
  });

  it("list returns names only, never values", async () => {
    const { createLocalSecretStore } = await loadModule();
    const store = createLocalSecretStore(OWNER_A);
    const secretValue = "super-secret-value-9f8e7d6c5b";
    await store.put("my-key", secretValue);
    const names = await store.list();
    expect(names).toEqual(["my-key"]);
    expect(JSON.stringify(names)).not.toContain(secretValue);
  });

  it("isolates secrets per owner", async () => {
    const { createLocalSecretStore } = await loadModule();
    const a = createLocalSecretStore(OWNER_A);
    const b = createLocalSecretStore(OWNER_B);
    await a.put("shared-name", "value-of-owner-a");
    await expect(b.list()).resolves.toEqual([]);
    await expect(b.get("shared-name")).resolves.toBeNull();
    await expect(a.get("shared-name")).resolves.toBe("value-of-owner-a");
  });

  it("keeps secret values out of sync journal and export bundle", async () => {
    const { createLocalSecretStore, toLocalSecretRef } = await loadModule();
    const store = createLocalSecretStore(OWNER_A);
    const secretValue = "journal-canary-abc123xyz";
    await store.put("canary", secretValue);
    const ref = toLocalSecretRef("canary");
    expect(ref).toBe("secret://local/canary");
    // Synthetic sync journal / export bundle carry only references, never values.
    const syncJournal = [
      { kind: "upsertNote", note: { title: "hello", body: `uses ${ref}` } },
      { kind: "appendOperation", operation: { config: { secretRef: ref } } },
    ];
    const exportBundle = {
      version: 1,
      workflows: [{ nodes: [{ config: { secretRef: ref } }] }],
    };
    const haystack = JSON.stringify({ syncJournal, exportBundle });
    expect(haystack).toContain(ref);
    expect(haystack).not.toContain(secretValue);
    const names = await store.list();
    expect(JSON.stringify({ names, syncJournal, exportBundle })).not.toContain(
      secretValue,
    );
  });

  it("makes no network requests during local operations", async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error("must not fetch"));
    vi.stubGlobal("fetch", fetchSpy);
    const { createLocalSecretStore } = await loadModule();
    const store = createLocalSecretStore(OWNER_A);
    await store.put("net-check", "net-value-1");
    await store.list();
    await store.get("net-check");
    await store.remove("net-check");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("flags secret://local/* as server-unresolvable", async () => {
    const mod = await loadModule();
    expect(mod.isServerUnresolvableSecretRef("secret://local/my-key")).toBe(
      true,
    );
    expect(mod.isServerUnresolvableSecretRef("secret://vault/my-key")).toBe(
      false,
    );
    expect(mod.isServerUnresolvableSecretRef("https://example.org")).toBe(
      false,
    );
    expect(
      mod.findServerUnresolvableSecretRefs({
        nodes: [
          { config: { secretRef: "secret://local/my-key" } },
          { config: { secretRef: "secret://vault/ok" } },
        ],
      }),
    ).toEqual(["secret://local/my-key"]);
  });
});

describe("SecretsSettings UI", () => {
  it("hides values after save, warns device-only, and confirms before delete", async () => {
    const { createLocalSecretStore } = await loadModule();
    const { SecretsSettings } = await import("../src/secrets/SecretsSettings");
    const store = createLocalSecretStore(OWNER_A);
    render(<SecretsSettings ownerId={OWNER_A} store={store} />);

    // Device-only warnings must be visible.
    expect(
      await screen.findByText(/hanya tersimpan pada perangkat\/browser ini/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/IndexedDB bukan encrypted credential vault/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/server runs will fail/i)).toBeInTheDocument();

    const nameInput = screen.getByLabelText(/secret name/i);
    const valueInput = screen.getByLabelText(/secret value/i);
    fireEvent.change(nameInput, { target: { value: "ui-key" } });
    fireEvent.change(valueInput, { target: { value: "ui-super-secret-777" } });
    fireEvent.click(screen.getByRole("button", { name: /save secret/i }));

    await waitFor(() => expect(screen.getByText("ui-key")).toBeInTheDocument());
    // Value must never be rendered; input is cleared after save.
    expect(screen.queryByText("ui-super-secret-777")).toBeNull();
    expect(
      (screen.getByLabelText(/secret value/i) as HTMLInputElement).value,
    ).toBe("");

    // Delete requires confirmation: first click arms, second confirms.
    fireEvent.click(screen.getByRole("button", { name: /delete ui-key/i }));
    expect(
      await screen.findByRole("button", { name: /confirm delete/i }),
    ).toBeInTheDocument();
    // Value still must not leak in confirm UI.
    expect(screen.queryByText("ui-super-secret-777")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /confirm delete/i }));
    await waitFor(() => expect(screen.queryByText("ui-key")).toBeNull());
  });

  it("flags secret://local/* as server-unresolvable in Run preflight", async () => {
    const { RunWorkflow } = await import("../src/executions/RunWorkflow");
    const workflow = {
      id: "66666666-6666-4666-8666-666666666666",
      workflowId: "33333333-3333-4333-8333-333333333333",
      projectId: "22222222-2222-4222-8222-222222222222",
      ownerId: OWNER_A,
      version: 1,
      createdAt: "2026-09-28T00:00:00.000Z",
      definition: {
        id: "33333333-3333-4333-8333-333333333333",
        projectId: "22222222-2222-4222-8222-222222222222",
        name: "Local secret flow",
        schemaVersion: 1,
        nodes: [
          {
            id: "55555555-5555-4555-8555-555555555555",
            toolId: "builtin.text.trim",
            toolVersion: "1.0.0",
            config: { secretRef: "secret://local/my-key" },
            input: { source: "workflow_input" },
          },
        ],
        edges: [],
      },
    };
    const tools = [
      {
        id: "builtin.text.trim",
        name: "Text Trim",
        version: "1.0.0",
        description: "trim",
        accepts: ["text"],
        produces: ["text"],
        permissions: [],
        capabilities: [],
        executionMode: "server",
        idempotency: "safe",
        configSchema: { type: "object" },
      },
    ] as never;
    render(
      <RunWorkflow
        projectId="22222222-2222-4222-8222-222222222222"
        workflow={workflow as never}
        tools={tools}
        grantedPermissions={[]}
        onBack={() => {}}
      />,
    );
    expect(await screen.findByText(/server-unresolvable/i)).toBeInTheDocument();
    expect(screen.getByText(/server runs will fail/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run workflow" })).toBeDisabled();
  });
});
