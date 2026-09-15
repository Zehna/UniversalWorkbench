const baseUrl = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:8080";
const maxAttempts = Number(process.env.SMOKE_MAX_ATTEMPTS ?? "30");
const retryDelayMs = Number(process.env.SMOKE_RETRY_DELAY_MS ?? "1000");

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitFor(label, check) {
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await check();
      return;
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        await sleep(retryDelayMs);
      }
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`${label} did not become ready: ${detail}`);
}

await waitFor("web shell", async () => {
  const response = await fetch(baseUrl);
  const body = await response.text();
  if (!response.ok || !body.includes("root")) {
    throw new Error(`received HTTP ${response.status}`);
  }
});

await waitFor("API liveness", async () => {
  const response = await fetch(`${baseUrl}/api/health/live`);
  const body = await response.json();
  if (!response.ok || body.status !== "ok") {
    throw new Error(`received ${response.status}: ${JSON.stringify(body)}`);
  }
});

await waitFor("API readiness", async () => {
  const response = await fetch(`${baseUrl}/api/health/ready`);
  const body = await response.json();
  if (!response.ok || body.status !== "ready") {
    throw new Error(`received ${response.status}: ${JSON.stringify(body)}`);
  }
});

console.log("docker HTTP smoke passed");
