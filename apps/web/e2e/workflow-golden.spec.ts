import { expect, test, type Page } from "@playwright/test";
import {
  createProject,
  loginOrSetup,
  newContext,
  openProject,
} from "./sync-helpers";

interface ProjectSummary {
  id: string;
  name: string;
}

interface ExecutionSummary {
  id: string;
  kind: "tool" | "workflow";
  status: string;
}

interface ExecutionStepSummary {
  id: string;
  toolId: string;
  status: string;
}

async function projectIdByName(page: Page, name: string): Promise<string> {
  return page.evaluate(async (projectName) => {
    const response = await fetch("/api/projects", { credentials: "include" });
    if (!response.ok) {
      throw new Error(`Unable to list projects: ${response.status}`);
    }
    const body = (await response.json()) as { projects?: ProjectSummary[] };
    const project = body.projects?.find((item) => item.name === projectName);
    if (!project) throw new Error(`Project ${projectName} was not found`);
    return project.id;
  }, name);
}

async function latestWorkflowExecution(
  page: Page,
  projectId: string,
): Promise<ExecutionSummary> {
  return page.evaluate(async (id) => {
    const response = await fetch(`/api/projects/${id}/executions`, {
      credentials: "include",
    });
    if (!response.ok) {
      throw new Error(`Unable to list executions: ${response.status}`);
    }
    const body = (await response.json()) as {
      executions?: ExecutionSummary[];
    };
    const execution = body.executions?.find(
      (item) => item.kind === "workflow",
    );
    if (!execution) throw new Error("Workflow execution was not found");
    return execution;
  }, projectId);
}

async function executionSteps(
  page: Page,
  projectId: string,
  executionId: string,
): Promise<ExecutionStepSummary[]> {
  return page.evaluate(
    async ({ project, execution }) => {
      const response = await fetch(
        `/api/projects/${project}/executions/${execution}`,
        { credentials: "include" },
      );
      if (!response.ok) {
        throw new Error(`Unable to read execution: ${response.status}`);
      }
      const body = (await response.json()) as {
        steps?: ExecutionStepSummary[];
      };
      return body.steps ?? [];
    },
    { project: projectId, execution: executionId },
  );
}

async function noteBody(
  page: Page,
  projectId: string,
  documentId: string,
): Promise<string> {
  return page.evaluate(
    async ({ project, document }) => {
      const response = await fetch(
        `/api/projects/${project}/documents/${document}`,
        { credentials: "include" },
      );
      if (!response.ok) {
        throw new Error(`Unable to read workflow note: ${response.status}`);
      }
      const body = (await response.json()) as {
        revision?: { content?: { body?: string } };
      };
      const value = body.revision?.content?.body;
      if (typeof value !== "string") {
        throw new Error("Workflow note body is missing");
      }
      return value;
    },
    { project: projectId, document: documentId },
  );
}

test("linear workflow runs through worker and is visible from a second browser", async ({
  browser,
}) => {
  const first = await newContext(browser);
  const firstPage = await first.newPage();
  await loginOrSetup(firstPage);

  const projectName = "Phase 3 Golden Project";
  const workflowName = "Golden Note Workflow";
  const noteTitle = "Golden Workflow Output";
  const noteText = "Hello from the Phase 3 worker";

  await createProject(firstPage, projectName);
  const projectId = await projectIdByName(firstPage, projectName);

  await expect(
    firstPage.getByRole("heading", { name: "Workflows" }),
  ).toBeVisible();
  await firstPage.getByRole("button", { name: "New Workflow" }).click();
  await firstPage.getByLabel("Workflow title").fill(workflowName);

  const addStep = firstPage.getByLabel("Add step");
  await addStep.selectOption({ label: "Text Template" });
  await firstPage.getByRole("button", { name: "Add Step" }).click();

  const templateConfig = firstPage.getByLabel("Text Template configuration");
  await templateConfig.fill(JSON.stringify({ template: noteText }));
  await templateConfig.blur();

  await expect
    .poll(async () =>
      addStep.locator("option").allTextContents(),
    )
    .toContain("Write Note");

  await addStep.selectOption({ label: "Write Note" });
  await firstPage.getByRole("button", { name: "Add Step" }).click();

  const noteConfig = firstPage.getByLabel("Write Note configuration");
  await noteConfig.fill(JSON.stringify({ title: noteTitle }));
  await noteConfig.blur();

  await firstPage.getByRole("button", { name: "Save Workflow" }).click();
  await expect(firstPage.getByRole("status")).toContainText("Saved locally");

  const run = firstPage.getByRole("button", { name: /^Run$/ });
  await expect(run).toBeEnabled({ timeout: 20_000 });
  await run.click();

  await expect(
    firstPage.getByRole("heading", { name: /Execution: succeeded/i }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(firstPage.getByText(/Receipts: 2/i)).toBeVisible();
  await expect(
    firstPage.getByText(/note · note-ref · Golden Workflow Output/i),
  ).toBeVisible();

  const execution = await latestWorkflowExecution(firstPage, projectId);
  expect(execution.status).toBe("succeeded");

  const steps = await executionSteps(firstPage, projectId, execution.id);
  const noteStep = steps.find((step) => step.toolId === "builtin.note.write");
  expect(noteStep).toBeDefined();
  expect(noteStep?.status).toBe("succeeded");
  expect(await noteBody(firstPage, projectId, noteStep!.id)).toBe(noteText);

  const second = await newContext(browser);
  const secondPage = await second.newPage();
  await loginOrSetup(secondPage);

  await expect
    .poll(async () =>
      secondPage.getByRole("button", { name: projectName }).count(),
    )
    .toBe(1);
  await openProject(secondPage, projectName);

  await expect
    .poll(async () =>
      secondPage.getByRole("button", { name: workflowName }).count(),
    )
    .toBe(1);

  const secondExecution = await latestWorkflowExecution(secondPage, projectId);
  expect(secondExecution.id).toBe(execution.id);
  expect(secondExecution.status).toBe("succeeded");
  expect(await noteBody(secondPage, projectId, noteStep!.id)).toBe(noteText);

  await first.close();
  await second.close();
});
