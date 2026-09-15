import { readFile } from 'node:fs/promises';

const expected = new Map([
  ['apps/web/package.json', '@uw/web'],
  ['apps/server/package.json', '@uw/server'],
  ['packages/contracts/package.json', '@uw/contracts'],
  ['packages/database/package.json', '@uw/database'],
  ['packages/shared/package.json', '@uw/shared'],
]);

let failed = false;
for (const [path, name] of expected) {
  try {
    const pkg = JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), 'utf8'));
    if (pkg.name !== name) {
      console.error(`${path}: expected ${name}, received ${pkg.name ?? '<missing>'}`);
      failed = true;
    }
  } catch (error) {
    console.error(`${path}: ${error.message}`);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log('workspace manifests verified');
