import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";

const OWNER = {
  id: "11111111-1111-4111-8111-111111111111",
  username: "owner",
  createdAt: "2026-09-18T00:00:00.000Z",
};
const PROJECT = {
  id: "22222222-2222-4222-8222-222222222222",
  ownerId: OWNER.id,
  name: "Research",
  description: null,
  schemaVersion: 1,
  createdAt: "2026-09-18T00:00:00.000Z",
  updatedAt: "2026-09-18T00:00:00.000Z",
};
const REVISION_1 = "33333333-3333-4333-8333-333333333333";
const REVISION_2 = "44444444-4444-4444-8444-444444444444";
const DOCUMENT = {
  id: "55555555-5555-4555-8555-555555555555",
  projectId: PROJECT.id,
  kind: "note" as const,
  title: "Sources",
  currentRevisionId: REVISION_1,
  createdAt: "2026-09-18T00:00:00.000Z",
  updatedAt: "2026-09-18T00:00:00.000Z",
};

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Phase 1 PWA flow", () => {
  it("shows login and keeps the password transient when login fails", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";

        if (url.endsWith("/setup/status")) {
          return jsonResponse({ initialized: true });
        }
        if (url.endsWith("/auth/session")) {
          return jsonResponse(
            { error: { code: "UNAUTHORIZED", message: "Authentication required" } },
            401,
          );
        }
        if (url.endsWith("/auth/login") && method === "POST") {
          return jsonResponse(
            { error: { code: "INVALID_CREDENTIALS", message: "Invalid credentials" } },
            401,
          );
        }

        throw new Error(`Unexpected fetch: ${method} ${url}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    expect(
      await screen.findByRole("heading", { name: /sign in/i }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/username/i), {
      target: { value: "owner" },
    });
    fireEvent.change(screen.getByLabelText(/^password$/i), {
      target: { value: "wrong-password-value" },
    });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));

    expect(await screen.findByText(/invalid credentials/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^password$/i)).toHaveValue("");
  });

  it("sets up the owner, creates a project and note, then preserves local text on revision conflict", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";

        if (url.endsWith("/setup/status")) {
          return jsonResponse({ initialized: false });
        }
        if (url.endsWith("/setup/owner") && method === "POST") {
          return jsonResponse({ owner: OWNER }, 201);
        }
        if (url.endsWith("/projects") && method === "GET") {
          return jsonResponse({ projects: [] });
        }
        if (url.endsWith("/projects") && method === "POST") {
          return jsonResponse({ project: PROJECT }, 201);
        }
        if (
          url.endsWith(`/projects/${PROJECT.id}/documents`) &&
          method === "GET"
        ) {
          return jsonResponse({ documents: [] });
        }
        if (
          url.endsWith(`/projects/${PROJECT.id}/documents`) &&
          method === "POST"
        ) {
          return jsonResponse(
            {
              document: DOCUMENT,
              revision: {
                id: REVISION_1,
                documentId: DOCUMENT.id,
                revisionNumber: 1,
                parentRevisionId: null,
                content: { body: "First note" },
                metadata: {},
                createdAt: DOCUMENT.createdAt,
              },
            },
            201,
          );
        }
        if (
          url.endsWith(`/projects/${PROJECT.id}/documents/${DOCUMENT.id}`) &&
          method === "PATCH"
        ) {
          return jsonResponse(
            {
              error: {
                code: "REVISION_CONFLICT",
                message: "Document revision conflict",
                currentRevisionId: REVISION_2,
              },
            },
            409,
          );
        }

        throw new Error(`Unexpected fetch: ${method} ${url}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    expect(
      await screen.findByRole("heading", { name: /create owner/i }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/username/i), {
      target: { value: "owner" },
    });
    fireEvent.change(screen.getByLabelText(/^password$/i), {
      target: { value: "a-very-secure-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create owner/i }));

    expect(
      await screen.findByRole("heading", { name: /projects/i }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/project name/i), {
      target: { value: "Research" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create project/i }));

    expect(
      await screen.findByRole("heading", { name: "Research" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /new note/i }));
    fireEvent.change(screen.getByLabelText(/note title/i), {
      target: { value: "Sources" },
    });
    fireEvent.change(screen.getByLabelText(/note body/i), {
      target: { value: "First note" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save note/i }));

    expect(await screen.findByDisplayValue("First note")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/note body/i), {
      target: { value: "My local edit" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save note/i }));

    expect(
      await screen.findByText(/newer revision exists/i),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue("My local edit")).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });
});
