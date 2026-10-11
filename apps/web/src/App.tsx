import { useState } from "react";
import type { OwnerPublic } from "@uw/contracts";
import { AuthGate } from "./auth/AuthGate";
import { OfflineBanner } from "./lib/OfflineBanner";
import { TabList } from "./lib/TabList";
import { ProjectList } from "./projects/ProjectList";
import { SecretsSettings } from "./secrets/SecretsSettings";
import { DiagnosticsView } from "./settings/DiagnosticsView";
import { McpSettings } from "./settings/McpSettings";
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
  const [tab, setTab] = useState<
    "projects" | "secrets" | "diagnostics" | "mcp"
  >("projects");
  return (
    <>
      <SyncStatusBadge status={status} />
      <OfflineBanner />
      <TabList
        aria-label="Workbench tabs"
        tabs={[
          { id: "projects", label: "Projects" },
          { id: "secrets", label: "Local Secrets" },
          { id: "diagnostics", label: "Diagnostics" },
          { id: "mcp", label: "MCP Servers" },
        ]}
        selected={tab}
        onSelect={(id) =>
          setTab(id as "projects" | "secrets" | "diagnostics" | "mcp")
        }
      />
      {tab === "secrets" ? (
        <SecretsSettings ownerId={owner.id} />
      ) : tab === "diagnostics" ? (
        <DiagnosticsView />
      ) : tab === "mcp" ? (
        <McpSettings />
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
