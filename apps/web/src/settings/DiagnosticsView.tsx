import { useEffect, useState } from "react";

interface DiagnosticsViewProps {
  fetchJson?: (path: string) => Promise<unknown>;
}

async function fetchJsonDefault(path: string): Promise<unknown> {
  const response = await fetch(path, { credentials: "same-origin" });
  if (!response.ok) {
    throw new Error(`Diagnostics request failed: ${response.status}`);
  }
  return (await response.json()) as unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null) {
    return value as Record<string, unknown>;
  }
  return {};
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "unknown";
}

export function DiagnosticsView({
  fetchJson = fetchJsonDefault,
}: DiagnosticsViewProps) {
  const [health, setHealth] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [healthBody, readinessBody] = await Promise.all([
          fetchJson("/api/diagnostics/health"),
          fetchJson("/api/diagnostics/readiness"),
        ]);
        if (cancelled) return;
        setHealth(asText(asRecord(healthBody).status));
        setChecks(asRecord(asRecord(readinessBody).checks));
      } catch {
        if (!cancelled) setError("Diagnostics service is unreachable");
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [fetchJson]);

  return (
    <section aria-labelledby="diagnostics-title">
      <h2 id="diagnostics-title">Diagnostics</h2>
      {error ? (
        <p role="alert">{error}</p>
      ) : (
        <>
          <p>System health: {health ?? "loading…"}</p>
          {checks ? (
            <ul>
              <li>Database: {asText(checks.database)}</li>
              <li>Storage: {asText(checks.storage)}</li>
              <li>Vault: {asText(asRecord(checks.vault).status)}</li>
            </ul>
          ) : (
            <p>Loading checks…</p>
          )}
          <a
            href="/api/diagnostics/recovery-bundle"
            download="recovery-bundle.json"
            aria-label="Download diagnostic recovery bundle"
          >
            Download diagnostic recovery bundle
          </a>
        </>
      )}
    </section>
  );
}
