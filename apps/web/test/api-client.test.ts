import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "../src/api/client";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();

  it("wraps non-JSON proxy errors as a structured ApiError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("<html>bad gateway</html>", {
          status: 502,
          headers: { "content-type": "text/html" },
        }),
      ),
    );

    await expect(api.setupStatus()).rejects.toMatchObject({
      name: "ApiError",
      status: 502,
      code: "REQUEST_FAILED",
      message: "Request failed",
    } satisfies Partial<ApiError>);
  });
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
