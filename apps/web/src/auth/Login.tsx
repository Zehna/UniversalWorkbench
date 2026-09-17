import { useState, type FormEvent } from "react";
import type { OwnerPublic } from "@uw/contracts";
import { ApiError, api } from "../api/client";

interface LoginProps {
  onReady(owner: OwnerPublic): void;
}

export function Login({ onReady }: LoginProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const owner = await api.login({ username, password });
      setPassword("");
      onReady(owner);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Unable to sign in");
      setPassword("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="login-title">
      <h2 id="login-title">Sign In</h2>
      <form onSubmit={submit}>
        <label>
          Username
          <input
            required
            autoComplete="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
        </label>
        <label>
          Password
          <input
            required
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {error ? <p role="alert">{error}</p> : null}
        <button type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign In"}
        </button>
      </form>
    </section>
  );
}
