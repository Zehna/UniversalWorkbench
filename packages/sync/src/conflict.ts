export function createConflictPayload(
  incoming: Record<string, unknown>,
  current: Record<string, unknown>,
): Record<string, unknown> {
  return {
    incoming: structuredClone(incoming),
    current: structuredClone(current),
  };
}

export function createTombstoneConflictPayload(
  incoming: Record<string, unknown>,
  cursor: string,
): Record<string, unknown> {
  return createConflictPayload(incoming, {
    deleted: true,
    cursor,
  });
}
