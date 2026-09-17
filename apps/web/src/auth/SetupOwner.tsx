import { useState, type FormEvent } from "react";
import type { OwnerPublic } from "@uw/contracts";
import { ApiError, api } from "../api/client";

interface SetupOwnerProps {
  onReady(owner: OwnerPublic): void;
}

export function SetupOwner({ onReady }: SetupOwnerProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const owner = await api.setupOwner({ username, password });
      setPassword("");
      onReady(owner);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Unable to create owner");
      setPassword("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="setup-title">
      <h2 id="setup-title">Create Owner</h2>
      <p>Create the private owner account for this Workbench.</p>
      <form onSubmit={submit}>
        <label>
          Username
          <input
            required
            minLength={3}
            maxLength={64}
            autoComplete="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
        </label>
        <label>
          Password
          <input
            required
            minLength={12}
            maxLength={128}
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {error ? <p role="alert">{error}</p> : null}
        <button type="submit" disabled={busy}>
          {busy ? "Creating…" : "Create Owner"}
        </button>
      </form>
    </section>
  );
}
