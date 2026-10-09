import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DiagnosticsView } from "../src/settings/DiagnosticsView";

describe("DiagnosticsView", () => {
  it("shows system health, checks, and a recovery bundle download", async () => {
    const fetchJson = vi.fn(async (path: string) => {
      if (path === "/api/diagnostics/health") return { status: "ok" };
      return {
        status: "ready",
        checks: {
          database: "ok",
          storage: "ok",
          vault: { status: "degraded", configured: false },
        },
      };
    });

    render(<DiagnosticsView fetchJson={fetchJson} />);

    expect(
      await screen.findByRole("heading", { name: /diagnostics/i }),
    ).toBeInTheDocument();
    expect(await screen.findByText(/database:\s*ok/i)).toBeInTheDocument();
    expect(await screen.findByText(/storage:\s*ok/i)).toBeInTheDocument();
    const download = await screen.findByRole("link", {
      name: /download diagnostic recovery bundle/i,
    });
    expect(download).toHaveAttribute(
      "href",
      "/api/diagnostics/recovery-bundle",
    );
  });

  it("reports unreachable diagnostics service accessibly", async () => {
    const fetchJson = vi.fn(async () => {
      throw new Error("network down");
    });

    render(<DiagnosticsView fetchJson={fetchJson} />);
    expect(
      await screen.findByRole("alert"),
    ).toBeInTheDocument();
  });
});
