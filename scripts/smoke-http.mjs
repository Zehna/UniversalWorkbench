const baseUrl = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:8080";

const web = await fetch(baseUrl);
if (!web.ok || !(await web.text()).includes("root")) {
  throw new Error("web shell is not reachable");
}

const live = await fetch(`${baseUrl}/api/health/live`);
if (!live.ok || (await live.json()).status !== "ok") {
  throw new Error("API liveness check failed");
}

const ready = await fetch(`${baseUrl}/api/health/ready`);
const readyBody = await ready.json();
if (!ready.ok || readyBody.status !== "ready") {
  throw new Error(`API readiness failed: ${JSON.stringify(readyBody)}`);
}

console.log("docker HTTP smoke passed");
