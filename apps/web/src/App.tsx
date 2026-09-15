import { useEffect, useState } from "react";
import { fetchHealth } from "./lib/health";

type HealthState = "checking" | "online" | "offline";

const shellStyle = {
  minHeight: "100vh",
  display: "grid",
  placeItems: "center",
  background: "#111111",
  color: "#f5f5f5",
  fontFamily: "system-ui, sans-serif",
  padding: "24px",
} as const;

const cardStyle = {
  width: "min(100%, 680px)",
  padding: "28px",
  border: "1px solid #333333",
  borderRadius: "18px",
  background: "#181818",
} as const;

export function App() {
  const [health, setHealth] = useState<HealthState>("checking");

  useEffect(() => {
    let active = true;
    void fetchHealth().then((status) => {
      if (active) setHealth(status);
    });
    return () => {
      active = false;
    };
  }, []);

  const label =
    health === "checking"
      ? "Checking API…"
      : health === "online"
        ? "API online"
        : "API offline";

  return (
    <main style={shellStyle}>
      <section style={cardStyle} aria-labelledby="workbench-title">
        <p>Phase 0 Foundation</p>
        <h1 id="workbench-title">Universal Workbench</h1>
        <p>
          A local-first, self-hosted workspace foundation for connected tools
          and reproducible workflows.
        </p>
        <p role="status" aria-live="polite">
          {label}
        </p>
      </section>
    </main>
  );
}
