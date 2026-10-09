import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "../src/lib/ConfirmDialog";
import { OfflineBanner } from "../src/lib/OfflineBanner";
import { TabList } from "../src/lib/TabList";
import { VirtualizedList } from "../src/lib/VirtualizedList";
import { ExecutionStatus } from "../src/executions/ExecutionStatus";
import { api } from "../src/api/client";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setOnline(value: boolean): void {
  Object.defineProperty(window.navigator, "onLine", {
    value,
    configurable: true,
  });
}

describe("VirtualizedList", () => {
  const items = Array.from({ length: 2000 }, (_, index) => `item-${index}`);

  function renderList() {
    return render(
      <VirtualizedList
        aria-label="Large list"
        items={items}
        itemHeight={40}
        containerHeight={400}
        overscan={2}
        renderItem={(item) => <button type="button">{item}</button>}
      />,
    );
  }

  it("renders only the visible window of a large list", () => {
    const { container } = renderList();
    const buttons = container.querySelectorAll("button");
    // 400px viewport / 40px rows + overscan: far fewer than 2000.
    expect(buttons.length).toBeLessThan(100);
    expect(buttons.length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "item-0" })).toBeInTheDocument();
    // The scroll window is an AT-exposed, keyboard-focusable landmark.
    const region = screen.getByRole("region", { name: "Large list" });
    expect(region).toHaveAttribute("tabindex", "0");
  });

  it("advances the window on scroll and keeps items keyboard-focusable", () => {
    const { container } = renderList();
    const scroller = container.querySelector(
      '[data-testid="virtual-scroller"]',
    ) as HTMLElement;
    // jsdom has no layout and clamps scrollTop to 0; override the getter so
    // the windowing logic observes a real scroll offset.
    Object.defineProperty(scroller, "scrollTop", {
      value: 8000,
      configurable: true,
    });
    fireEvent.scroll(scroller);
    expect(
      screen.queryByRole("button", { name: "item-0" }),
    ).not.toBeInTheDocument();
    const late = screen.getByRole("button", { name: "item-200" });
    expect(late).toBeInTheDocument();
    late.focus();
    expect(document.activeElement).toBe(late);
  });
});

describe("TabList", () => {
  function renderTabs(onSelect: (id: string) => void = () => undefined) {
    return render(
      <TabList
        aria-label="Sections"
        tabs={[
          { id: "a", label: "Alpha" },
          { id: "b", label: "Beta" },
          { id: "c", label: "Gamma" },
        ]}
        selected="a"
        onSelect={onSelect}
      />,
    );
  }

  it("moves selection with arrow keys and exposes tab semantics", () => {
    const onSelect = vi.fn();
    render(
      <TabList
        aria-label="Sections"
        tabs={[
          { id: "a", label: "Alpha" },
          { id: "b", label: "Beta" },
        ]}
        selected="a"
        onSelect={onSelect}
      />,
    );
    const tablist = screen.getByRole("tablist", { name: "Sections" });
    expect(tablist).toBeInTheDocument();
    const first = screen.getByRole("tab", { name: "Alpha" });
    expect(first).toHaveAttribute("aria-selected", "true");
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(onSelect).toHaveBeenCalledWith("b");
  });

  it("supports Home and End keys", () => {
    const onSelect = vi.fn();
    renderTabs(onSelect);
    const tabs = screen.getAllByRole("tab");
    tabs[1]!.focus();
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(onSelect).toHaveBeenCalledWith("c");
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(onSelect).toHaveBeenCalledWith("a");
  });
});

describe("ConfirmDialog", () => {
  it("traps focus, labels the dialog, and closes on Escape", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        title="Delete secret?"
        description="This cannot be undone."
        confirmLabel="Confirm delete"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    const dialog = screen.getByRole("alertdialog", {
      name: "Delete secret?",
    });
    expect(dialog).toBeInTheDocument();
    const confirm = screen.getByRole("button", { name: "Confirm delete" });
    const cancel = screen.getByRole("button", { name: "Cancel" });
    // The safe default owns initial focus: Enter alone must never delete.
    expect(document.activeElement).toBe(cancel);

    // Tab on the last focusable element wraps to the first.
    fireEvent.keyDown(cancel, { key: "Tab" });
    expect(document.activeElement).toBe(confirm);

    // Shift+Tab on the first wraps to the last.
    fireEvent.keyDown(confirm, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(cancel);

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe("OfflineBanner", () => {
  it("shows an offline banner and hides it on reconnect", async () => {
    setOnline(false);
    render(<OfflineBanner />);
    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent(/offline/i);

    setOnline(true);
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("renders nothing while online", () => {
    setOnline(true);
    const { container } = render(<OfflineBanner />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("ExecutionStatus large payloads and disconnects", () => {
  const projectId = "11111111-1111-4111-8111-111111111111";

  function executionWithPayload(payload: string) {
    return {
      execution: {
        id: "exec-1",
        status: "completed",
        projectId,
        traceId: "t",
        error: null,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        startedAt: null,
        finishedAt: null,
      },
      steps: [
        {
          nodeId: "n1",
          toolId: "builtin.echo",
          toolVersion: "1.0.0",
          attempt: 1,
          status: "completed",
          outputContexts: [
            {
              id: "out-1",
              type: "text",
              schemaVersion: 1,
              mimeType: "text/plain",
              metadata: {},
              payload,
              provenance: { sourceContextIds: [] },
              capabilities: [],
            },
          ],
          error: null,
          inputContext: null,
          outputContextIds: [],
        },
      ],
      receipt: null,
    };
  }

  it("truncates huge payloads behind an expander", async () => {
    setOnline(true);
    const big = `x`.repeat(10000);
    vi.spyOn(api, "getExecution").mockResolvedValue(
      executionWithPayload(big) as never,
    );
    render(
      <ExecutionStatus
        projectId={projectId}
        executionId="exec-1"
        onBack={() => undefined}
      />,
    );
    const expander = await screen.findByRole("button", {
      name: /show full payload/i,
    });
    expect(expander).toHaveAttribute("aria-expanded", "false");
    expect(document.body.textContent).not.toContain(big);
    fireEvent.click(expander);
    expect(await screen.findByText(big)).toBeInTheDocument();
    expect(expander).toHaveAttribute("aria-expanded", "true");
  });

  it("shows a reconnect notice when the browser is offline", async () => {
    setOnline(false);
    vi.spyOn(api, "getExecution").mockRejectedValue(new Error("offline"));
    render(
      <ExecutionStatus
        projectId={projectId}
        executionId="exec-1"
        onBack={() => undefined}
      />,
    );
    expect(
      await screen.findByText(/connection lost.*retry/i),
    ).toBeInTheDocument();
  });
});
