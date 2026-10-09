import type {
  ExecutionBudget,
  ExecutionJson,
  ExecutionRecord,
  ExecutionStepRecord,
  FinishStepInput,
  StoredWorkflowRun,
  WorkflowExecutionStore,
} from "@uw/execution";
import { ExecutionEngineError, ExecutionRepositoryError } from "@uw/execution";
import type { WorkflowDefinition } from "@uw/contracts";
import type { Pool, QueryResultRow } from "pg";
import { createPostgresExecutionRepository } from "./execution.js";

interface WorkRow extends QueryResultRow {
  owner_id: string;
  project_id: string;
  workflow_version: number;
  definition: WorkflowDefinition;
  granted_permissions: string[];
  budget: ExecutionBudget;
}

interface ExistingDefinition extends QueryResultRow {
  id: string;
  matches: boolean;
  owner_id: string;
  project_id: string;
}

export function createPostgresWorkflowExecutionStore(
  pool: Pool,
): WorkflowExecutionStore {
  const execution = createPostgresExecutionRepository(pool);

  return {
    ...execution,

    async submit(input) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const project = await client.query(
          `select id from projects
           where id = $1 and owner_id = $2 and deleted_at is null
           for update`,
          [input.projectId, input.ownerId],
        );
        if (project.rowCount !== 1) {
          throw new ExecutionRepositoryError(
            "EXECUTION_SCOPE_MISMATCH",
            "Project is not available in this owner scope",
          );
        }

        const existing = await client.query<ExistingDefinition>(
          `select id, owner_id, project_id,
                  (definition = $3::jsonb) as matches
             from workflow_definitions
            where workflow_id = $1 and version = $2`,
          [
            input.workflow.id,
            input.workflowVersion,
            JSON.stringify(input.workflow),
          ],
        );
        let definitionId = input.workflowDefinitionId;
        if (existing.rows[0]) {
          const found = existing.rows[0];
          if (
            !found.matches ||
            found.owner_id !== input.ownerId ||
            found.project_id !== input.projectId
          ) {
            throw new ExecutionEngineError(
              "WORKFLOW_VERSION_CONFLICT",
              "Workflow version cannot be overwritten with a different definition or owner",
            );
          }
          definitionId = found.id;
        } else {
          await client.query(
            `insert into workflow_definitions
              (id, workflow_id, version, owner_id, project_id, name,
               schema_version, definition, created_at)
             values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
            [
              definitionId,
              input.workflow.id,
              input.workflowVersion,
              input.ownerId,
              input.projectId,
              input.workflow.name,
              input.workflow.schemaVersion,
              JSON.stringify(input.workflow),
              input.createdAt,
            ],
          );
        }

        await client.query(
          `insert into executions
            (id, owner_id, project_id, workflow_definition_id, status,
             trace_id, input_context, usage, created_at)
           values ($1,$2,$3,$4,'queued',$5,$6::jsonb,'{}'::jsonb,$7)`,
          [
            input.id,
            input.ownerId,
            input.projectId,
            definitionId,
            input.traceId,
            JSON.stringify(input.inputContext),
            input.createdAt,
          ],
        );
        await client.query(
          `insert into execution_requests
            (execution_id, granted_permissions, budget)
           values ($1,$2::jsonb,$3::jsonb)`,
          [
            input.id,
            JSON.stringify(input.grantedPermissions),
            JSON.stringify(input.budget),
          ],
        );
        await client.query(
          `insert into execution_queue (execution_id, available_at)
           values ($1,$2)`,
          [input.id, input.createdAt],
        );
        await client.query("commit");
        return {
          id: input.id,
          ownerId: input.ownerId,
          projectId: input.projectId,
          workflowDefinitionId: definitionId,
          traceId: input.traceId,
          inputContext: input.inputContext,
          status: "queued",
          startedAt: null,
          finishedAt: null,
          error: null,
          usage: {} as ExecutionJson,
          createdAt: input.createdAt,
        } satisfies ExecutionRecord;
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async load(executionId): Promise<StoredWorkflowRun | null> {
      const result = await pool.query<WorkRow>(
        `select e.owner_id, e.project_id, w.version as workflow_version,
                w.definition, r.granted_permissions, r.budget
           from executions e
           join workflow_definitions w on w.id = e.workflow_definition_id
           join execution_requests r on r.execution_id = e.id
          where e.id = $1`,
        [executionId],
      );
      const row = result.rows[0];
      if (!row) return null;
      const view = await execution.get(
        row.owner_id,
        row.project_id,
        executionId,
      );
      if (!view) return null;
      return {
        view,
        workflow: row.definition,
        workflowVersion: row.workflow_version,
        grantedPermissions: row.granted_permissions,
        budget: row.budget,
      };
    },

    async suspend(input: { executionId: string; usage: ExecutionJson }) {
      return execution.suspendExecution(input.executionId, input.usage);
    },

    async resume(executionId: string) {
      return execution.resumeExecution(executionId);
    },

    async startStep(step: ExecutionStepRecord) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const running = await client.query(
          "select id from executions where id = $1 and status = 'running' for update",
          [step.executionId],
        );
        if (
          running.rowCount !== 1 ||
          step.status !== "running" ||
          step.startedAt === null ||
          step.finishedAt !== null ||
          step.outputContexts.length !== 0
        ) {
          throw new ExecutionRepositoryError(
            "INVALID_STATE",
            "Cannot start an execution step",
          );
        }
        try {
          await client.query(
            `insert into execution_steps
              (id, execution_id, node_id, tool_id, tool_version,
               attempt, status, started_at, finished_at, input_context,
               output_contexts, error, idempotency_key)
             values ($1,$2,$3,$4,$5,$6,'running',$7,null,$8::jsonb,'[]'::jsonb,null,$9)`,
            [
              step.id,
              step.executionId,
              step.nodeId,
              step.toolId,
              step.toolVersion,
              step.attempt,
              step.startedAt,
              JSON.stringify(step.inputContext),
              step.idempotencyKey,
            ],
          );
        } catch (error) {
          if (
            error !== null &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "23505"
          ) {
            throw new ExecutionRepositoryError(
              "DUPLICATE_STEP",
              "Step attempt already exists",
            );
          }
          throw error;
        }
        await client.query("commit");
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async finishStep(step: FinishStepInput) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const running = await client.query(
          "select id from executions where id = $1 and status = 'running' for update",
          [step.executionId],
        );
        if (running.rowCount !== 1) {
          throw new ExecutionRepositoryError(
            "INVALID_STATE",
            "Execution is not running",
          );
        }
        const updated = await client.query(
          `update execution_steps
              set status = $5, finished_at = $6,
                  output_contexts = $7::jsonb, error = $8::jsonb
            where id = $1 and execution_id = $2
              and node_id = $3 and attempt = $4 and status = 'running'`,
          [
            step.id,
            step.executionId,
            step.nodeId,
            step.attempt,
            step.status,
            step.finishedAt,
            JSON.stringify(step.outputContexts),
            step.error ? JSON.stringify(step.error) : null,
          ],
        );
        if (updated.rowCount !== 1) {
          throw new ExecutionRepositoryError(
            "INVALID_STATE",
            "Step was already finalized or claimed by another attempt",
          );
        }
        if (step.status === "completed") {
          for (const output of step.outputContexts) {
            for (const fromContextId of output.provenance.sourceContextIds) {
              await client.query(
                `insert into provenance_edges
                  (execution_id, from_context_id, to_context_id, node_id)
                 values ($1,$2,$3,$4)
                 on conflict (execution_id, from_context_id, to_context_id, node_id)
                 do nothing`,
                [step.executionId, fromContextId, output.id, step.nodeId],
              );
            }
          }
        }
        await client.query("commit");
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
