import { readFile } from "node:fs/promises";

const [path] = process.argv.slice(2);
if (!path)
  throw new Error("Usage: node scripts/verify-no-secrets.mjs <log-file>");

const canary = process.env.SMOKE_SECRET_CANARY;
if (!canary) throw new Error("SMOKE_SECRET_CANARY is required");
const aiKey = process.env.SMOKE_AI_KEY;

const text = await readFile(path, "utf8");
const forbidden = [
  { label: "secret canary", test: (value) => value.includes(canary) },
  {
    label: "AI key canary",
    test: (value) => (aiKey ? value.includes(aiKey) : false),
  },
  { label: "session cookie", test: (value) => /uw_session=/i.test(value) },
  { label: "Cookie header", test: (value) => /\bcookie:\s*[^\s]/i.test(value) },
  { label: "password field", test: (value) => /"password"\s*:/i.test(value) },
  {
    label: "authorization bearer",
    test: (value) => /authorization:\s*bearer\s+\S/i.test(value),
  },
  {
    // A secret:// reference adjacent to an assignment (ref followed by a
    // value) indicates a disclosed value. Bare references in configs are
    // names, not secrets, and do not match: the separator must follow the ref.
    label: "secret value",
    test: (value) =>
      /secret:\/\/[^\s"'`]+\s*["']?\s*[:=]\s*["']?[^\s"'`]+/i.test(value),
  },
];

for (const rule of forbidden) {
  if (rule.test(text)) {
    throw new Error(
      `Docker logs leaked forbidden credential material: ${rule.label}`,
    );
  }
}

console.log("Phase 2 Docker logs contain no credential canaries");
