# Phase 10 Implementation Plan: Sandboxed Code Interpreter & Dynamic Computation

Branch: `phase-10-code-interpreter`

---

### Task 1: Code Interpreter Contracts & Output Envelopes
- **Target:** `packages/contracts/src/code.ts`, `packages/contracts/src/context.ts`, `packages/contracts/src/index.ts`
- **Output:** `CodeInterpreterConfigSchema`, `CodeExecutionResultSchema`, add `code_result` to `ContextTypeSchema`.
- **Tests:** `packages/contracts/test/phase-10-contracts.test.ts`
- **Commit:** `feat(contracts): add code interpreter config and result schemas`

---

### Task 2: Sandboxed Execution Sandbox Engine
- **Target:** `packages/tools/src/code/sandbox.ts`, `packages/tools/src/code/types.ts`
- **Output:** Safe VM runner with isolated globals, console capture (stdout/stderr), and timeout enforcement.
- **Tests:** `packages/tools/test/code-sandbox.test.ts`
- **Commit:** `feat(tools): implement safe isolated code execution sandbox`

---

### Task 3: Builtin Code Interpreter Tool (`builtin.code.interpreter@1.0.0`)
- **Target:** `packages/tools/src/builtin/code.ts`, `packages/tools/src/index.ts`
- **Output:** Descriptor and executor for `builtin.code.interpreter@1.0.0`, input context mapping, and `code_result` envelope generation.
- **Tests:** `packages/tools/test/code-tool.test.ts`
- **Commit:** `feat(tools): add builtin.code.interpreter tool and executor`

---

### Task 4: Server Wiring & Composition Registry Integration
- **Target:** `apps/server/src/composition.ts`, `apps/server/src/routes/send-to.ts`
- **Output:** Register code interpreter in ToolRegistry, support Send-to Document for `code_result`, verify agent tool whitelist dispatch.
- **Tests:** `apps/server/test/code-workflow.integration.test.ts`
- **Commit:** `feat(server): wire code interpreter tool into server registry`

---

### Task 5: Web UI — Code Step Editor & Console Viewer
- **Target:** `apps/web/src/workflows/WorkflowStepEditor.tsx`, `apps/web/src/executions/ExecutionStatus.tsx`
- **Output:** Code textarea editor with language presets, console output viewer (stdout/stderr/result display).
- **Tests:** `apps/web/test/code-step-editor.test.tsx`
- **Commit:** `feat(web): add code step editor and console output viewer`

---

### Task 6: Golden E2E Verification, Architecture Runbook, & Phase 10 Gate Pass
- **Target:** `packages/execution/test/golden-code.integration.test.ts`, `docs/architecture/phase-10.md`, `README.md`
- **Output:** End-to-end golden test (Supervisor delegates to Data Analyst Sub-Agent -> Sub-agent executes code interpreter -> Computes data -> Verified output), docs, gate pass.
- **Commit:** `docs: close phase 10 code interpreter`
