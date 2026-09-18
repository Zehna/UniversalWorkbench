import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("App", () => {
  it("shows the product shell and first-run owner setup", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ initialized: false }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    render(<App />);
    expect(
      screen.getByRole("heading", { name: "Universal Workbench" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("heading", { name: /create owner/i }),
    ).toBeInTheDocument();
  });
});
