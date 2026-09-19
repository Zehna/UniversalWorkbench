import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type { OwnerPublic } from "@uw/contracts";
import { openLocalStore } from "../local/open-local-store";
import { createBrowserSyncClient } from "./client";
import { createSyncCoordinator, type SyncCoordinator } from "./coordinator";
import type { SyncStatus } from "./status";

export type SyncCoordinatorFactory = (
  owner: OwnerPublic,
) => Promise<SyncCoordinator>;

interface SyncRuntimeValue {
  coordinator: SyncCoordinator;
  status: SyncStatus;
}

const SyncRuntimeContext = createContext<SyncRuntimeValue | null>(null);

export async function createBrowserCoordinator(
  owner: OwnerPublic,
): Promise<SyncCoordinator> {
  const store = await openLocalStore();
  return createSyncCoordinator({
    ownerId: owner.id,
    store,
    client: createBrowserSyncClient(),
  });
}

interface SyncRuntimeProps {
  owner: OwnerPublic;
  factory?: SyncCoordinatorFactory | undefined;
  children: ReactNode;
}

export function SyncRuntime({
  owner,
  factory = createBrowserCoordinator,
  children,
}: SyncRuntimeProps) {
  const [runtime, setRuntime] = useState<SyncRuntimeValue | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let coordinator: SyncCoordinator | null = null;
    let unsubscribe = () => {};

    setRuntime(null);
    setError(null);

    void (async () => {
      try {
        coordinator = await factory(owner);
        if (disposed) {
          await coordinator.stop();
          return;
        }

        unsubscribe = coordinator.subscribe((status) => {
          if (!disposed && coordinator) {
            setRuntime({ coordinator, status });
          }
        });
        await coordinator.start();
      } catch (cause) {
        if (!disposed) {
          setError(
            cause instanceof Error
              ? cause.message
              : "Unable to initialize local workspace",
          );
        }
      }
    })();

    return () => {
      disposed = true;
      unsubscribe();
      if (coordinator) void coordinator.stop();
    };
  }, [factory, owner]);

  if (error) return <p role="alert">{error}</p>;
  if (!runtime) return <p role="status">Opening local workspace…</p>;

  return (
    <SyncRuntimeContext.Provider value={runtime}>
      {children}
    </SyncRuntimeContext.Provider>
  );
}

export function useSyncRuntime(): SyncRuntimeValue {
  const value = useContext(SyncRuntimeContext);
  if (!value) throw new Error("Sync runtime is not available");
  return value;
}
