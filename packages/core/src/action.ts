export interface ActionContext {
  actorId: string;
  traceId: string;
  projectId?: string;
}

export interface ActionSpec<I, O> {
  name: string;
  input: I;
  context: ActionContext;
  authorize(): Promise<void>;
  run(): Promise<O>;
  audit(result: O): Promise<void>;
}

export async function executeAction<I, O>(spec: ActionSpec<I, O>): Promise<O> {
  await spec.authorize();
  const result = await spec.run();
  await spec.audit(result);
  return result;
}
