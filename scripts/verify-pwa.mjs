import { access, readFile } from "node:fs/promises";

const dist = new URL("../apps/web/dist/", import.meta.url);
const manifestUrl = new URL("manifest.webmanifest", dist);
const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));

const requiredSizes = ["192x192", "512x512"];
for (const size of requiredSizes) {
  const icon = manifest.icons?.find(
    (candidate) => candidate.sizes === size && candidate.src,
  );

  if (!icon) {
    throw new Error(`PWA manifest is missing a ${size} icon`);
  }

  const relativePath = icon.src.startsWith("/") ? icon.src.slice(1) : icon.src;
  await access(new URL(relativePath, dist));
}

if (manifest.display !== "standalone" || manifest.start_url !== "/") {
  throw new Error("PWA manifest has invalid launch metadata");
}

console.log("PWA manifest and icon assets verified");
