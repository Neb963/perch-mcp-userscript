/** T2 synthetic DO soak. No external provider operations or billing credentials. */
import { createCapacityHarness } from "./gateway-capacity-harness.js";
const durationMs = Number(process.env.SOAK_DURATION_MS ?? 1800000),
  count = Number(process.env.SOAK_WORKSPACES ?? 20);
if (
  !Number.isSafeInteger(durationMs) ||
  durationMs < 1000 ||
  durationMs > 3600000 ||
  !Number.isSafeInteger(count) ||
  count < 1 ||
  count > 100
)
  throw new Error("Invalid soak duration or workspace count.");
const h = await createCapacityHarness(count);
const samples: number[] = [];
let iterations = 0,
  failures = 0;
const started = performance.now();
let lastReport = started,
  lastHeartbeat = started;
function report(final = false) {
  const sorted = [...samples].sort((a, b) => a - b),
    q = (p: number) =>
      sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ??
      null;
  console.log(
    JSON.stringify({
      final,
      tier: "T2",
      workspaces: count,
      elapsedMs: Math.round(performance.now() - started),
      iterations,
      operations: samples.length,
      failures,
      latencyMs: {
        p50: q(0.5),
        p95: q(0.95),
        p99: q(0.99),
        max: sorted.at(-1) ?? null,
      },
      nodeRssBytes: process.memoryUsage().rss,
      notes:
        "Local workerd synthetic native replies; not deployed CPU/quota or Firefox evidence.",
    }),
  );
}
try {
  while (performance.now() - started < durationMs) {
    const results = await Promise.allSettled(h.fixtures.map(h.cycle));
    for (const result of results) {
      if (result.status === "fulfilled") samples.push(result.value);
      else {
        failures++;
        console.error(String(result.reason));
      }
    }
    iterations++;
    if (performance.now() - lastHeartbeat >= 60000) {
      await Promise.all(h.fixtures.map((f) => h.browser(f, "heartbeat")));
      lastHeartbeat = performance.now();
    }
    if (performance.now() - lastReport >= 60000) {
      report();
      lastReport = performance.now();
    }
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.min(5000, Math.max(0, durationMs - (performance.now() - started))),
      ),
    );
  }
  report(true);
  if (failures) process.exitCode = 1;
} finally {
  await h.close();
}
