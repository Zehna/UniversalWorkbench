import { useEffect, useState, type FormEvent } from "react";
import { ConfirmDialog } from "../lib/ConfirmDialog";
import {
  LOCAL_SECRETS_DEVICE_WARNING,
  LOCAL_SECRETS_VAULT_WARNING,
  LOCAL_SECRET_SERVER_WARNING,
  createLocalSecretStore,
  toLocalSecretRef,
  type LocalSecretStore,
} from "./local-secrets";

interface SecretsSettingsProps {
  ownerId: string;
  store?: LocalSecretStore;
}

export function SecretsSettings({ ownerId, store }: SecretsSettingsProps) {
  const [activeStore] = useState<LocalSecretStore>(
    () => store ?? createLocalSecretStore(ownerId),
  );
  const [names, setNames] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);

  async function refresh() {
    try {
      setNames(await activeStore.list());
    } catch {
      setError("Unable to load local secrets");
    }
  }

  useEffect(() => {
    void refresh();
  }, [activeStore]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await activeStore.put(name.trim(), value);
      setName("");
      // Never keep the plaintext in memory longer than needed; the UI
      // shows names only after save.
      setValue("");
      await refresh();
    } catch {
      setError("Invalid secret name or value");
    } finally {
      setSaving(false);
    }
  }

  async function confirmRemove(target: string) {
    setError(null);
    try {
      await activeStore.remove(target);
      setConfirming(null);
      await refresh();
    } catch {
      setError("Unable to delete local secret");
    }
  }

  return (
    <section aria-labelledby="local-secrets-title">
      <h2 id="local-secrets-title">Local Secrets</h2>
      <p>{LOCAL_SECRETS_DEVICE_WARNING}</p>
      <p>{LOCAL_SECRETS_VAULT_WARNING}</p>
      <p>
        Workflows store only the reference{" "}
        <code>secret://local/&lt;name&gt;</code>, never the value.{" "}
        {LOCAL_SECRET_SERVER_WARNING}
      </p>
      {error ? <p role="alert">{error}</p> : null}
      <form onSubmit={(event) => void save(event)}>
        <label>
          Secret name
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="openai-key"
            autoComplete="off"
          />
        </label>
        <label>
          Secret value
          <input
            type="password"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            autoComplete="off"
          />
        </label>
        <button type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save secret"}
        </button>
      </form>
      {names.length === 0 ? (
        <p>No local secrets on this device.</p>
      ) : (
        <ul>
          {names.map((item) => (
            <li key={item}>
              <span>{item}</span> <code>{toLocalSecretRef(item)}</code>{" "}
              {confirming === item ? (
                <ConfirmDialog
                  title={`Delete ${item}?`}
                  description={`Delete the local secret ${item}? This cannot be undone.`}
                  confirmLabel="Confirm delete"
                  onConfirm={() => void confirmRemove(item)}
                  onCancel={() => setConfirming(null)}
                />
              ) : (
                <button
                  type="button"
                  aria-label={`Delete ${item}`}
                  onClick={() => setConfirming(item)}
                >
                  Delete
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
