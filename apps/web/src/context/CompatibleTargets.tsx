import { useEffect, useState } from "react";
import type { ContextType } from "@uw/contracts";
import type { CompatibleToolTarget, WorkflowApiClient } from "../workflows/api";

interface CompatibleTargetsProps {
  type: ContextType;
  api: WorkflowApiClient;
  onSelect?: (target: CompatibleToolTarget) => void;
}

export function CompatibleTargets({
  type,
  api,
  onSelect,
}: CompatibleTargetsProps) {
  const [targets, setTargets] = useState<CompatibleToolTarget[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void api
      .compatibleTargets(type)
      .then((items) => {
        if (active) setTargets(items);
      })
      .catch((cause) => {
        if (active) {
          setError(
            cause instanceof Error
              ? cause.message
              : "Unable to load compatible targets",
          );
        }
      });
    return () => {
      active = false;
    };
  }, [api, type]);

  if (error) return <p role="alert">{error}</p>;
  if (targets.length === 0) return <p>No compatible targets.</p>;

  return (
    <ul>
      {targets.map((target) => (
        <li
          key={`${target.definition.id}@${target.definition.version}:${target.inputPort.name}`}
        >
          <button type="button" onClick={() => onSelect?.(target)}>
            {target.definition.displayName}
          </button>
        </li>
      ))}
    </ul>
  );
}
