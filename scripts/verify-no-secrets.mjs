import { readFile } from "node:fs/promises";

const [path] = process.argv.slice(2);
if (!path) throw new Error("Usage: node scripts/verify-no-secrets.mjs <log-file>");

const canary = process.env.SMOKE_SECRET_CANARY;
if (!canary) throw new Error("SMOKE_SECRET_CANARY is required");

const text = await readFile(path, "utf8");
const forbidden = [
  { label: "secret canary", test: (value) => value.includes(canary) },
  { label: "session cookie", test: (value) => /uw_session=/i.test(value) },
  { label: "Cookie header", test: (value) => /\bcookie:\s*[^\s]/i.test(value) },
  { label: "password field", test: (value) => /"password"\s*:/i.test(value) },
];

for (const rule of forbidden) {
  if (rule.test(text)) {
    throw new Error(`Docker logs leaked forbidden credential material: ${rule.label}`);
  }
}

console.log("Phase 2 Docker logs contain no credential canaries");
