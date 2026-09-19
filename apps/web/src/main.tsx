import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { Project } from "@uw/contracts";
import { App } from "./App";
import { openLocalStore } from "./local/open-local-store";

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

function installPhase2TestBridge(): void {
  const storePromise = openLocalStore();

  const target = window as Window & {
    __phase2?: {
      createProjectOffline(name: string): Promise<void>;
      projectNames(): Promise<string[]>;
    };
  };

  target.__phase2 = {
    async createProjectOffline(name) {
      const store = await storePromise;
      const now = new Date().toISOString();
      const project: Project = {
        id: crypto.randomUUID(),
        ownerId: crypto.randomUUID(),
        name,
        description: null,
        schemaVersion: 1,
        createdAt: now,
        updatedAt: now,
      };
      await store.transaction((tx) => tx.upsertProject(project));
    },
    async projectNames() {
      const store = await storePromise;
      return (await store.listProjects()).map((project) => project.name);
    },
  };
}

if (import.meta.env.DEV && window.location.pathname === "/__phase2-test") {
  installPhase2TestBridge();
  root.textContent = "Phase 2 local persistence test";
} else {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
