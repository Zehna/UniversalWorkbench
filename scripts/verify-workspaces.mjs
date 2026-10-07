import { readFile } from "node:fs/promises";

const expected = new Map([
  ["apps/web/package.json", "@uw/web"],
  ["apps/server/package.json", "@uw/server"],
  ["packages/artifacts/package.json", "@uw/artifacts"],
  ["packages/auth/package.json", "@uw/auth"],
  ["packages/context/package.json", "@uw/context"],
  ["packages/contracts/package.json", "@uw/contracts"],
  ["packages/core/package.json", "@uw/core"],
  ["packages/database/package.json", "@uw/database"],
  ["packages/documents/package.json", "@uw/documents"],
  ["packages/egress/package.json", "@uw/egress"],
  ["packages/execution/package.json", "@uw/execution"],
  ["packages/providers/package.json", "@uw/providers"],
  ["packages/shared/package.json", "@uw/shared"],
  ["packages/storage/package.json", "@uw/storage"],
  ["packages/sync/package.json", "@uw/sync"],
  ["packages/tools/package.json", "@uw/tools"],
  ["packages/workflow/package.json", "@uw/workflow"],
]);

let failed = false;
for (const [path, name] of expected) {
  try {
    const pkg = JSON.parse(
      await readFile(new URL(`../${path}`, import.meta.url), "utf8"),
    );
    if (pkg.name !== name) {
      console.error(
        `${path}: expected ${name}, received ${pkg.name ?? "<missing>"}`,
      );
      failed = true;
    }
  } catch (error) {
    console.error(`${path}: ${error.message}`);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log("workspace manifests verified");
