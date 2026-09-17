import { useEffect, useState, type ReactNode } from "react";
import type { OwnerPublic } from "@uw/contracts";
import { ApiError, api } from "../api/client";
import { Login } from "./Login";
import { SetupOwner } from "./SetupOwner";

type AuthState =
  | { kind: "checking" }
  | { kind: "setup" }
  | { kind: "login" }
  | { kind: "ready"; owner: OwnerPublic }
  | { kind: "error"; message: string };

interface AuthGateProps {
  children(owner: OwnerPublic): ReactNode;
}

export function AuthGate({ children }: AuthGateProps) {
  const [state, setState] = useState<AuthState>({ kind: "checking" });

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const initialized = await api.setupStatus();
        if (!active) return;
        if (!initialized) {
          setState({ kind: "setup" });
          return;
        }
        try {
          const owner = await api.session();
          if (active) setState({ kind: "ready", owner });
        } catch (cause) {
          if (!active) return;
          if (cause instanceof ApiError && cause.status === 401) {
            setState({ kind: "login" });
            return;
          }
          throw cause;
        }
      } catch {
        if (active) setState({ kind: "error", message: "Unable to connect to Workbench" });
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  if (state.kind === "checking") return <p role="status">Loading Workbench…</p>;
  if (state.kind === "setup") {
    return <SetupOwner onReady={(owner) => setState({ kind: "ready", owner })} />;
  }
  if (state.kind === "login") {
    return <Login onReady={(owner) => setState({ kind: "ready", owner })} />;
  }
  if (state.kind === "error") return <p role="alert">{state.message}</p>;
  return <>{children(state.owner)}</>;
}
