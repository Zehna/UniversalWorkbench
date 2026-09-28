import { AuthGate } from "./auth/AuthGate";
import { ProjectList } from "./projects/ProjectList";
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

function Workbench() {
  const { status } = useSyncRuntime();
  return (
    <>
      <SyncStatusBadge status={status} />
      <ProjectList />
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
              <Workbench />
            </SyncRuntime>
          )}
        </AuthGate>
      </section>
    </main>
  );
}
