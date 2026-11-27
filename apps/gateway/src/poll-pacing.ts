import { ApiError } from "./common.js";

export function pollWaitMs(value: unknown): number {
  if (value === undefined) return 15000;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new ApiError("INVALID_INPUT", "waitMs must be a finite nonnegative number.");
  return Math.min(15000, Math.floor(value));
}

/** Detach the response body before waiting so idle clients do not pin the Workspace DO. */
export async function paceIdlePoll(
  response: Response, waitMs: number,
  sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
): Promise<Response> {
  if (!response.ok || !waitMs) return response;
  const bytes = await response.arrayBuffer();
  const result = JSON.parse(new TextDecoder().decode(bytes)) as { operations?: unknown; idleWaitMs?: unknown };
  if (Array.isArray(result.operations) && result.operations.length === 0)
    await sleep(Math.min(waitMs, result.idleWaitMs === 15000 ? 15000 : 5000));
  return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
}
