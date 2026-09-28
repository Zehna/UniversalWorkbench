import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeDatabasePool,
  createDatabasePool,
  migrateDatabase,
} from "../src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");

const pool = createDatabasePool(databaseUrl);

async function resetDatabaseSchemas(): Promise<void> {
  await pool.query("drop schema if exists public cascade");
  await pool.query("drop schema if exists drizzle cascade");
  await pool.query("create schema public");
}

async function seedScope(): Promise<{
  ownerId: string;
  projectId: string;
  workflowDefinitionId: string;
}> {
  const ownerId = randomUUID();
  const projectId = randomUUID();
  const workflowDefinitionId = randomUUID();
  await pool.query(
    `insert into owner_accounts
      (id, singleton_key, username, password_algorithm, password_salt, password_hash, password_parameters)
     values ($1, 1, $2, 'argon2id', 'salt', 'hash', '{}'::jsonb)`,
    [ownerId, "owner-" + ownerId],
  );
  await pool.query(
    "insert into projects (id, owner_id, name) values ($1, $2, 'Phase 3')",
    [projectId, ownerId],
  );
  await pool.query(
    `insert into workflow_definitions
      (id, workflow_id, version, owner_id, project_id, name, schema_version, definition)
     values ($1, $2, 1, $3, $4, 'Workflow', 1, $5::jsonb)`,
    [
      workflowDefinitionId,
      randomUUID(),
      ownerId,
      projectId,
      JSON.stringify({ schemaVersion: 1, nodes: [], edges: [] }),
    ],
  );
  return { ownerId, projectId, workflowDefinitionId };
}

async function insertExecution(
  scope: Awaited<ReturnType<typeof seedScope>>,
): Promise<string> {
  const executionId = randomUUID();
  await pool.query(
    `insert into executions
      (id, owner_id, project_id, workflow_definition_id, status, trace_id, input_context)
     values ($1,$2,$3,$4,'queued',$5,$6::jsonb)`,
    [
      executionId,
      scope.ownerId,
      scope.projectId,
      scope.workflowDefinitionId,
      randomUUID(),
      JSON.stringify({
        id: randomUUID(),
        type: "json",
        schemaVersion: 1,
        mimeType: "application/json",
        metadata: {},
        payload: {},
        provenance: { sourceContextIds: [] },
        capabilities: [],
      }),
    ],
  );
  return executionId;
}

beforeEach(async () => {
  await resetDatabaseSchemas();
  await migrateDatabase(pool);
});

afterAll(async () => {
  await resetDatabaseSchemas();
  await closeDatabasePool(pool);
});

describe("Phase 3 execution migration", () => {
  it("creates all durable execution tables and can migrate twice", async () => {
    await migrateDatabase(pool);
    const result = await pool.query<{ table_name: string }>(
      `select table_name
         from information_schema.tables
        where table_schema = 'public'
          and table_name in (
            'workflow_definitions',
            'executions',
            'execution_steps',
            'provenance_edges',
            'execution_receipts'
          )
        order by table_name`,
    );
    expect(result.rows.map((row) => row.table_name)).toEqual([
      "execution_receipts",
      "execution_steps",
      "executions",
      "provenance_edges",
      "workflow_definitions",
    ]);
  });

  it("enforces execution status, timing and workflow foreign keys", async () => {
    const scope = await seedScope();
    const inputContext = JSON.stringify({
      id: randomUUID(),
      type: "json",
      schemaVersion: 1,
      mimeType: "application/json",
      metadata: {},
      payload: {},
      provenance: { sourceContextIds: [] },
      capabilities: [],
    });

    await expect(
      pool.query(
        `insert into executions
          (id, owner_id, project_id, workflow_definition_id, status, trace_id, input_context)
         values ($1,$2,$3,$4,'invalid',$5,$6::jsonb)`,
        [
          randomUUID(),
          scope.ownerId,
          scope.projectId,
          scope.workflowDefinitionId,
          randomUUID(),
          inputContext,
        ],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    await expect(
      pool.query(
        `insert into executions
          (id, owner_id, project_id, workflow_definition_id, status, trace_id, input_context)
         values ($1,$2,$3,$4,'queued',$5,$6::jsonb)`,
        [
          randomUUID(),
          scope.ownerId,
          scope.projectId,
          randomUUID(),
          randomUUID(),
          inputContext,
        ],
      ),
    ).rejects.toMatchObject({ code: "23503" });

    await expect(
      pool.query(
        `insert into executions
          (id, owner_id, project_id, workflow_definition_id, status, trace_id, input_context, started_at)
         values ($1,$2,$3,$4,'queued',$5,$6::jsonb,now())`,
        [
          randomUUID(),
          scope.ownerId,
          scope.projectId,
          scope.workflowDefinitionId,
          randomUUID(),
          inputContext,
        ],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("enforces positive unique step attempts", async () => {
    const scope = await seedScope();
    const executionId = await insertExecution(scope);
    await pool.query(
      "update executions set status = 'running', started_at = now() where id = $1",
      [executionId],
    );
    const nodeId = randomUUID();
    const inputContext = JSON.stringify({
      id: randomUUID(),
      type: "text",
      schemaVersion: 1,
      mimeType: "text/plain",
      metadata: {},
      payload: "hello",
      provenance: { sourceContextIds: [] },
      capabilities: [],
    });
    const insert = (id: string, attempt: number) =>
      pool.query(
        `insert into execution_steps
          (id, execution_id, node_id, tool_id, tool_version, attempt, status,
           started_at, finished_at, input_context, output_contexts)
         values ($1,$2,$3,'builtin.text.trim','1.0.0',$4,'completed',
           now(),now(),$5::jsonb,'[]'::jsonb)`,
        [id, executionId, nodeId, attempt, inputContext],
      );

    await expect(insert(randomUUID(), 0)).rejects.toMatchObject({
      code: "23514",
    });
    await insert(randomUUID(), 1);
    await expect(insert(randomUUID(), 1)).rejects.toMatchObject({
      code: "23505",
    });
  });

  it("allows only one final receipt and makes it immutable", async () => {
    const scope = await seedScope();
    const executionId = await insertExecution(scope);
    const receipt = JSON.stringify({ status: "cancelled", safe: true });
    await pool.query(
      `insert into execution_receipts (execution_id, receipt)
       values ($1,$2::jsonb)`,
      [executionId, receipt],
    );

    await expect(
      pool.query(
        `insert into execution_receipts (execution_id, receipt)
         values ($1,$2::jsonb)`,
        [executionId, receipt],
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      pool.query(
        "update execution_receipts set receipt = '{}'::jsonb where execution_id = $1",
        [executionId],
      ),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      pool.query("delete from execution_receipts where execution_id = $1", [
        executionId,
      ]),
    ).rejects.toMatchObject({ code: "55000" });
  });

  it("keeps workflow definition versions immutable", async () => {
    const scope = await seedScope();
    await expect(
      pool.query(
        "update workflow_definitions set name = 'Changed' where id = $1",
        [scope.workflowDefinitionId],
      ),
    ).rejects.toMatchObject({ code: "55000" });
  });
});
