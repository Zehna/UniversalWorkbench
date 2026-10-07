import { useState } from "react";
import type { OwnerPublic } from "@uw/contracts";
import { AuthGate } from "./auth/AuthGate";
import { ProjectList } from "./projects/ProjectList";
import { SecretsSettings } from "./secrets/SecretsSettings";
import {
  SyncRuntime,
  type SyncCoordinatorFactory,
  useSyncRuntime,
} from "./sync/runtime";
import { SyncStatusBadge } from "./sync/SyncStatusBadge";

const shellStyle = {
  minHeight: "100vh",
  background: "#111111",
  color: "#f5f5f5",
  fontFamily: "system-ui, sans-serif",
  padding: "clamp(8px, 3vw, 20px)",
  boxSizing: "border-box",
} as const;

const cardStyle = {
  width: "min(100%, 760px)",
  margin: "0 auto",
  padding: "clamp(12px, 3vw, 24px)",
  boxSizing: "border-box",
  overflowWrap: "anywhere",
  border: "1px solid #333333",
  borderRadius: "18px",
  background: "#181818",
} as const;

function Workbench({ owner }: { owner: OwnerPublic }) {
  const { status } = useSyncRuntime();
  const [tab, setTab] = useState<"projects" | "secrets">("projects");
  return (
    <>
      <SyncStatusBadge status={status} />
      <nav
        aria-label="Workbench tabs"
        style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
      >
        <button
          type="button"
          role="tab"
          aria-selected={tab === "projects"}
          onClick={() => setTab("projects")}
        >
          Projects
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "secrets"}
          onClick={() => setTab("secrets")}
        >
          Local Secrets
        </button>
      </nav>
      {tab === "secrets" ? (
        <SecretsSettings ownerId={owner.id} />
      ) : (
        <ProjectList />
      )}
    </>
  );
}

export function App({
  syncFactory,
}: {
  syncFactory?: SyncCoordinatorFactory;
} = {}) {
  return (
    <main style={shellStyle}>
      <section style={cardStyle} aria-labelledby="workbench-title">
        <p>Local-first Sync · Workflow Runner</p>
        <h1 id="workbench-title">Universal Workbench</h1>
        <AuthGate>
          {(owner) => (
            <SyncRuntime owner={owner} factory={syncFactory}>
              <Workbench owner={owner} />
            </SyncRuntime>
          )}
        </AuthGate>
      </section>
    </main>
  );
}
