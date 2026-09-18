import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/client";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("API client routing", () => {
  it("routes application API requests through the /api reverse-proxy prefix", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ initialized: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.setupStatus();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/setup/status",
      expect.objectContaining({ credentials: "include" }),
    );
  });
});
