import { test } from "node:test";
import assert from "node:assert/strict";
import { projectMcpImages } from "../../apps/gateway/src/mcp-media.js";
import { ApiError, omitDevelopmentResult } from "../../apps/gateway/src/common.js";
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6N2sAAAAASUVORK5CYII=";
function outcome(tool = "read_image", base64 = png, mimeType = "image/png") {
  return {
    operationId: "image-op",
    status: "SUCCEEDED",
    tool,
    data: {
      operationId: "image-op",
      status: "SUCCEEDED",
      effectState: "VERIFIED",
      data: {
        path: "scratch/image.png",
        width: 1,
        height: 1,
        mimeType,
        content: [{ type: "image", mimeType, data: base64 }],
      },
    },
  };
}
test("known succeeded image outcomes become standard MCP blocks with one copy of base64", () => {
  for (const tool of ["read_image", "capture_page_image", "generate_image"]) {
    const original = outcome(tool),
      projected = projectMcpImages(original);
    assert.equal(projected.images.length, 1);
    assert.equal(projected.images[0]?.data, png);
    assert.ok(!JSON.stringify(projected.data).includes(png));
    assert.ok(JSON.stringify(original).includes(png));
  }
});
test("ordinary tool results and unverified media outcomes remain unchanged", () => {
  for (const value of [
    outcome("page_eval"),
    outcome("read"),
    { ...outcome(), status: "UNKNOWN" },
    null,
  ]) {
    const result = projectMcpImages(value);
    assert.equal(result.data, value);
    assert.deepEqual(result.images, []);
  }
});
test("image projection rejects malformed MIME, base64, identity and cumulative over-budget bytes", () => {
  assert.throws(() =>
    projectMcpImages(outcome("read_image", png, "image/svg+xml")),
  );
  assert.throws(() =>
    projectMcpImages(outcome("read_image", png, "image/jpeg")),
  );
  assert.throws(() => projectMcpImages(outcome("read_image", "not base64")));
  const wrong = outcome();
  wrong.data.operationId = "another-op";
  assert.throws(() => projectMcpImages(wrong));
  const bytes = new Uint8Array(600000);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const encoded = Buffer.from(bytes).toString("base64"),
    large = outcome("read_image", encoded);
  large.data.data.content.push({ ...large.data.data.content[0]! });
  assert.throws(() => projectMcpImages(large), /1 MiB/);
  assert.throws(
    () => projectMcpImages(outcome("read_image", "A".repeat(1400000))),
    /1 MiB/,
  );
});

test("S03-010 rejected image projection keeps the original success receipt and hides all raw bytes", () => {
  const secret = "PRIVATE-SOURCE-FIXTURE-MUST-NEVER-ESCAPE";
  const original: Record<string,unknown> = {
    ...outcome("capture_page_image", png, "image/jpeg"),
    resolution: {internal: secret},
    lateObservation: {internal: secret},
    result: {providerPayload: secret},
  };
  const raw = original.data as Record<string,unknown>;
  const terminal = raw.data as Record<string,unknown>;
  terminal.hiddenOriginalSource = secret;
  const before = structuredClone(original);
  assert.throws(() => projectMcpImages(original),
    (error:unknown) => error instanceof ApiError && error.code === "INVALID_INPUT");
  const omitted = omitDevelopmentResult(original, "UNAVAILABLE");
  assert.equal(omitted.status, "SUCCEEDED");
  assert.equal(omitted.operationId, "image-op");
  assert.equal(omitted.result, null);
  assert.equal(omitted.resultAvailability, "UNAVAILABLE");
  assert.deepEqual(omitted.error, {
    code: "RESULT_UNAVAILABLE",
    message: "The requested result bytes cannot be delivered.",
    retryable: false,
    recovery: "Inspect the retained operation receipt. Do not replay this intent to recover its result.",
  });
  assert.doesNotMatch(JSON.stringify(omitted), /PRIVATE-SOURCE-FIXTURE|iVBORw0KGgo/);
  assert.deepEqual(original, before, "projection and redaction must not mutate the durable operation summary");
});
