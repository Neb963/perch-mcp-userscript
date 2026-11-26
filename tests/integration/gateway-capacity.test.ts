import { test } from "node:test";
import assert from "node:assert/strict";
import { createCapacityHarness } from "./gateway-capacity-harness.js";
test("1/5/10/20 concurrent isolated SQLite Workspaces, overload and heartbeat recovery", async () => {
  const h = await createCapacityHarness(20);
  try {
    for (const size of [1, 5, 10, 20]) {
      const samples = await Promise.all(h.fixtures.slice(0, size).map(h.cycle));
      assert.equal(samples.length, size);
      assert.ok(samples.every((n) => n < 10000));
    }
    const f = h.fixtures[0]!,
      other = h.fixtures[1]!;
    const queue = await Promise.all(
      Array.from({ length: 8 }, () => h.admit(f)),
    );
    await assert.rejects(
      () => h.admit(f),
      (e) => (e as { status: number }).status === 429,
    );
    const otherLatency = await h.cycle(other);
    assert.ok(
      otherLatency < 2000,
      "Saturated Workspace cannot block independent Workspace",
    );
    const pulse = await h.browser(other, "heartbeat");
    assert.ok(Number(pulse.expiresAt) > Date.now() + 170000);
    const pending = new Set(queue.map((a) => String(a.operationId)));
    for (let i = 0; i < queue.length; i++) {
      const poll = await h.browser(f, "poll", { waitMs: 0 });
      const operationId = String(
        (poll.operations as Record<string, unknown>[])[0]?.operationId,
      );
      assert.ok(pending.delete(operationId));
      await h.browser(f, "reply", {
        operationId,
        phase: "SUCCEEDED",
        result: { operationId, status: "SUCCEEDED", effectState: "VERIFIED" },
      });
    }
  } finally {
    await h.close();
  }
});
test("retired lease only accepts exact outstanding terminal; UNKNOWN resolution preserves original status", async () => {
  const h = await createCapacityHarness(1);
  try {
    const f = h.fixtures[0]!,
      admitted = await h.admit(f),
      operationId = String(admitted.operationId);
    await h.browser(f, "poll", { waitMs: 0 });
    await h.browser(f, "reply", { operationId, phase: "RUNNING" });
    await h.browser(f, "release");
    await assert.rejects(() => h.browser(f, "heartbeat"));
    const result = {
      operationId,
      status: "UNKNOWN",
      effectState: "POSSIBLE",
      error: {
        code: "EFFECT_UNKNOWN",
        message: "Interrupted fixture",
        retryable: false,
        recovery: "Inspect source and resolve explicitly.",
      },
    };
    await h.browser(f, "reply", { operationId, phase: "UNKNOWN", result });
    const status = await h.status(f, operationId);
    assert.equal(status.status, "UNKNOWN");
    assert.equal(status.epoch, f.lease.epoch);
    const list = await h.get("/api/v1/admin/workspaces");
    const w = (list.items as Record<string, unknown>[])[0]!;
    const resolution = {
      expectedRevision: w.revision,
      operationId,
      epoch: status.epoch,
      bindingRevision: status.bindingRevision,
      observedRevision: "fixture-revision",
      observedDigest: "a".repeat(64),
      evidence: "Synthetic source inspection after settled operation",
      acknowledgeUncertainty: true,
    };
    await assert.rejects(() =>
      h.request("/api/v1/admin/workspaces/" + f.workspaceId + "/resolve", {
        ...resolution,
        operationId: "nonexistent-operation",
      }),
    );
    const resolved = await h.request(
      "/api/v1/admin/workspaces/" + f.workspaceId + "/resolve",
      resolution,
    );
    assert.equal(resolved.status, "UNKNOWN");
    assert.equal(
      (resolved.resolution as { resolvedByOperator: boolean })
        .resolvedByOperator,
      true,
    );
    await h.reclaim(f);
    await h.cycle(f);
    assert.equal((await h.status(f, operationId)).status, "UNKNOWN");
  } finally {
    await h.close();
  }
});
test("pending OAuth cannot follow a rebind; child permits stop immediately after policy revocation", async () => {
  const h = await createCapacityHarness(1);
  try {
    const f = h.fixtures[0]!;
    const request = {
      clientId: "pending-client",
      redirectUri: "https://client.test/callback",
      scope: ["mcp"],
      resource: "https://capacity.test/mcp/" + f.agentId,
      responseType: "code",
      state: "fixture",
      codeChallenge: "fixture",
      codeChallengeMethod: "S256",
    };
    const pending = await h.internal(h.registry, "/internal/oauth/pending", {
      request,
    });
    const approvals = await h.get("/api/v1/admin/approvals");
    const approval = (approvals.items as Record<string, unknown>[]).find(
      (x) => x.id === pending.id,
    )!;
    const rows = await h.get("/api/v1/admin/workspaces");
    const w = (rows.items as Record<string, unknown>[])[0]!;
    await h.request("/api/v1/admin/workspaces/" + f.workspaceId + "/bind", {
      expectedRevision: w.revision,
      binding: { ...f.binding, draftId: "changed-draft" },
      replace: true,
    });
    await assert.rejects(() =>
      h.request("/api/v1/admin/approvals/" + pending.id + "/decision", {
        expectedRevision: approval.revision,
        digest: approval.digest,
        decision: "approve",
      }),
    );
    // A separate fixture retains valid binding to exercise child authority during a running parent.
  } finally {
    await h.close();
  }
  const live = await createCapacityHarness(1);
  try {
    const f = live.fixtures[0]!,
      op = await live.admit(f),
      operationId = String(op.operationId);
    await live.browser(f, "poll", { waitMs: 0 });
    await live.browser(f, "reply", { operationId, phase: "RUNNING" });
    const permitted = await live.browser(f, "permit", {
      operationId,
      tool: "read",
      args: { path: "main.pjs" },
    });
    assert.ok((permitted.permissions as string[]).includes("READ_SOURCE"));
    const rows = await live.get("/api/v1/admin/workspaces");
    const w = (rows.items as Record<string, unknown>[])[0]!;
    await live.update("/api/v1/admin/workspaces/" + f.workspaceId, {
      expectedRevision: w.revision,
      permissions: ["READ_SOURCE", "READ_RESOURCES"],
    });
    await assert.rejects(() =>
      live.browser(f, "permit", {
        operationId,
        tool: "read",
        args: { path: "main.pjs" },
      }),
    );
  } finally {
    await live.close();
  }
});
