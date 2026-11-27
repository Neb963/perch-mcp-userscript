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
    const recoveryBefore = await h.get('/api/v1/admin/workspaces/'+f.workspaceId+'/recovery');
    assert.equal(recoveryBefore.action,'RECONCILE');
    assert.deepEqual((recoveryBefore.blockingOperations as {operationId:string;resolvable:boolean}[])
      .map(x=>[x.operationId,x.resolvable]),[[operationId,true]]);
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
    const afterFirst=await h.get('/api/v1/admin/workspaces/'+f.workspaceId);
    // An interrupted Worker-to-Registry resolution acknowledgement must not
    // produce a second epoch or become an unrecoverable stale revision.
    const retry=await h.request('/api/v1/admin/workspaces/'+f.workspaceId+'/resolve',resolution);
    assert.equal(retry.status,'UNKNOWN');
    assert.equal((await h.get('/api/v1/admin/workspaces/'+f.workspaceId)).revision,afterFirst.revision);
    await assert.rejects(()=>h.request('/api/v1/admin/workspaces/'+f.workspaceId+'/resolve',
      {...resolution,evidence:'different observation'}));
    const recoveryAfter = await h.get('/api/v1/admin/workspaces/'+f.workspaceId+'/recovery');
    assert.equal(recoveryAfter.action,'RECONNECT');
    assert.deepEqual(recoveryAfter.blockingOperations,[]);
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
test("Resource metadata pagination, reference paging and Agent-private ACL remain distinct", async () => {
  const h = await createCapacityHarness(2);
  try {
    const f = h.fixtures[0]!,
      other = h.fixtures[1]!;
    await h.request("/api/v1/admin/resources", {
      resource: {
        id: "private-fixture",
        kind: "skill",
        body: "line one\nline two\n",
        files: { "references/api.md": "reference one\nreference two" },
        enabled: false,
      },
    });
    const state = await h.get("/api/v1/admin/state");
    await h.request("/api/v1/admin/resources/assign", {
      expectedRevision: state.libraryRevision,
      resourceId: "private-fixture",
      scopeType: "agent",
      scopeId: f.agentId,
      enabled: true,
    });
    const skill = await h.internal(h.registry, "/internal/resource-tool", {
      props: f.props,
      agentId: f.agentId,
      permissions: ["READ_RESOURCES"],
      tool: "skill",
      args: { id: "private-fixture" },
    });
    assert.equal(skill.body, "line one\nline two\n");
    await assert.rejects(() =>
      h.internal(h.registry, "/internal/resource-tool", {
        props: other.props,
        agentId: other.agentId,
        permissions: ["READ_RESOURCES"],
        tool: "skill",
        args: { id: "private-fixture" },
      }),
    );
    const reference = await h.internal(h.registry, "/internal/resource-tool", {
      props: f.props,
      agentId: f.agentId,
      permissions: ["READ_RESOURCES"],
      tool: "read_documentation",
      args: {
        id: "private-fixture",
        path: "references/api.md",
        offset: 2,
        limit: 1,
      },
    });
    assert.equal(reference.text, "2: reference two");
    const body = await h.internal(h.registry, "/internal/resource-tool", {
      props: f.props,
      agentId: f.agentId,
      permissions: ["READ_RESOURCES"],
      tool: "read_documentation",
      args: { id: "private-fixture", offset: 1, limit: 1 },
    });
    assert.equal(body.text, "1: line one");
    for (let i = 0; i < 100; i++)
      await h.request("/api/v1/admin/resources", {
        resource: {
          id: "pagination-" + i,
          kind: "document",
          body: "fixture body",
        },
      });
    const first = await h.get("/api/v1/admin/resources");
    assert.equal((first.items as unknown[]).length, 100);
    assert.ok(first.cursor);
    assert.ok(
      (first.items as Record<string, unknown>[]).every(
        (r) => !("body" in r) && !("files" in r),
      ),
    );
    const second = await h.get(
      "/api/v1/admin/resources?cursor=" +
        encodeURIComponent(String(first.cursor)),
    );
    assert.ok((second.items as unknown[]).length > 0);
    assert.equal(second.revision, first.revision);
    await h.request("/api/v1/admin/resources", {
      resource: {
        id: "pagination-extra",
        kind: "document",
        body: "changed library",
      },
    });
    await assert.rejects(() =>
      h.get(
        "/api/v1/admin/resources?cursor=" +
          encodeURIComponent(String(first.cursor)),
      ),
    );
  } finally {
    await h.close();
  }
});
test("configured registry budget bounds creation without a fixed Agent count", async () => {
  const h = await createCapacityHarness(1, { REGISTRY_WORKSPACE_BUDGET: "1" });
  try {
    const state = await h.get("/api/v1/admin/state");
    assert.equal((state.limits as { workspaces: number }).workspaces, 1);
    await assert.rejects(
      () => h.request("/api/v1/admin/workspaces", { label: "over-budget" }),
      (e) => (e as { status: number }).status === 429,
    );
  } finally {
    await h.close();
  }
});

test("operation handles remain fenced to their authenticated Agent and binding revision", async () => {
  const h = await createCapacityHarness(1);
  try {
    const f = h.fixtures[0]!,
      admitted = await h.admit(f),
      operationId = String(admitted.operationId);
    await h.browser(f, "poll", { waitMs: 0 });
    await h.browser(f, "reply", {
      operationId,
      phase: "SUCCEEDED",
      result: {
        operationId,
        status: "SUCCEEDED",
        effectState: "VERIFIED",
        data: { privateSource: "original binding only" },
      },
    });
    const stub = h.wns.get(h.wns.idFromName(f.workspaceId));
    for (const scope of [
      {
        bindingRevision: Number(f.lease.bindingRevision) + 1,
        agentId: f.agentId,
      },
      { bindingRevision: f.lease.bindingRevision, agentId: "another-agent" },
    ])
      await assert.rejects(
        h.internal(stub, "/internal/status", {
          workspaceId: f.workspaceId,
          operationId,
          ...scope,
        }),
        (e) => (e as { status: number }).status === 404,
      );
    const allowed = await h.internal(stub, "/internal/status", {
      workspaceId: f.workspaceId,
      operationId,
      bindingRevision: f.lease.bindingRevision,
      agentId: f.agentId,
    });
    assert.equal(allowed.status, "SUCCEEDED");
  } finally {
    await h.close();
  }
});
test("rebind and detach cannot orphan a dispatched read or writer reservation", async () => {
  const h = await createCapacityHarness(1);
  try {
    const f = h.fixtures[0]!,
      admitted = await h.admit(f),
      operationId = String(admitted.operationId);
    await h.browser(f, "poll", { waitMs: 0 });
    await h.browser(f, "reply", { operationId, phase: "RUNNING" });
    const w = await h.get("/api/v1/admin/workspaces/" + f.workspaceId);
    for (const action of ["bind", "detach"])
      await assert.rejects(
        h.request("/api/v1/admin/workspaces/" + f.workspaceId + "/" + action, {
          expectedRevision: w.revision,
          ...(action === "bind" ? { binding: f.binding, replace: true } : {}),
        }),
        (e) => (e as { status: number }).status === 409,
      );
    assert.equal(
      (await h.get("/api/v1/admin/workspaces/" + f.workspaceId)).revision,
      w.revision,
    );
    await h.browser(f, "reply", {
      operationId,
      phase: "SUCCEEDED",
      result: { operationId, status: "SUCCEEDED", effectState: "VERIFIED" },
    });
    await h.request("/api/v1/admin/workspaces/" + f.workspaceId + "/detach", {
      expectedRevision: w.revision,
    });
  } finally {
    await h.close();
  }
});
test("credential recovery retains inert identity evidence so an older held write can be resolved before rebinding", async () => {
  const recoverySecret = "synthetic-recovery-".padEnd(64, "r"),
    h = await createCapacityHarness(1, { RECOVERY_SECRET: recoverySecret });
  try {
    const f = h.fixtures[0]!,
      admitted = await h.admit(
        f,
        "write",
        { path: "main.pjs", content: "fixture" },
        true,
        ["WRITE_SOURCE"],
      ),
      operationId = String(admitted.operationId);
    await h.browser(f, "poll", { waitMs: 0 });
    await h.browser(f, "reply", {
      operationId,
      phase: "UNKNOWN",
      result: {
        operationId,
        status: "UNKNOWN",
        effectState: "POSSIBLE",
        error: {
          code: "EFFECT_UNKNOWN",
          message: "Synthetic interrupted write",
          retryable: false,
          recovery: "Inspect fixture",
        },
      },
    });
    const recovered = await h.request("/api/v1/admin/recover", {
      recoverySecret,
      browserInstallationId: "recovered-browser",
    });
    const get = async (path: string) => {
      const r = await h.mf.dispatchFetch("https://capacity.test" + path, {
        headers: { Authorization: "Bearer " + recovered.adminCredential },
      });
      assert.equal(r.status, 200);
      return (await r.json()) as Record<string, unknown>;
    };
    const w = await get("/api/v1/admin/workspaces/" + f.workspaceId);
    assert.equal(w.binding, null);
    assert.equal(
      (w.recoveryBinding as { binding: { generatorId: string } }).binding
        .generatorId,
      f.binding.generatorId,
    );
    await h.request(
      "/api/v1/admin/workspaces/" + f.workspaceId + "/resolve",
      {
        expectedRevision: w.revision,
        operationId,
        epoch: f.lease.epoch,
        bindingRevision: f.lease.bindingRevision,
        observedRevision: "inspected-fixture",
        observedDigest: "a".repeat(64),
        evidence: "Explicit synthetic operator source/provider inspection",
        acknowledgeUncertainty: true,
      },
      String(recovered.adminCredential),
    );
    const current = await get("/api/v1/admin/workspaces/" + f.workspaceId);
    const bound = await h.request(
      "/api/v1/admin/workspaces/" + f.workspaceId + "/bind",
      {
        expectedRevision: current.revision,
        binding: { ...f.binding, browserInstallationId: "recovered-browser" },
      },
      String(recovered.adminCredential),
    );
    assert.ok(bound.binding);
    assert.equal(bound.recoveryBinding, undefined);
    assert.equal((await h.status(f, operationId)).status, "UNKNOWN");
  } finally {
    await h.close();
  }
});

test("SQL cursor budgets do not scale with terminal history while idle or active", async () => {
  const h = await createCapacityHarness(1);
  try {
    const f = h.fixtures[0]!;
    const stub = h.wns.get(h.wns.idFromName(f.workspaceId));
    const usage = async () => await h.internal(stub,"/internal/sql-usage",{}) as unknown as {reads:number;writes:number;unmetered:number;statements:number};
    const registryUsage=async()=>await h.internal(h.registry,"/internal/sql-usage",{}) as unknown as {reads:number;writes:number;unmetered:number;statements:number};
    const measure = async (fn:()=>Promise<unknown>) => {
      const before=await usage(); await fn(); const after=await usage();
      assert.equal(after.unmetered,0,"real SQL cursors must be metered");
      // The same instance must serve both samples; do not mistake an eviction for a reduction.
      assert.ok(after.statements>=before.statements);
      return {reads:after.reads-before.reads,writes:after.writes-before.writes};
    };
    const idle=()=>h.browser(f,"poll",{waitMs:0});
    const idleBefore=await measure(idle);
    const registryBefore=await registryUsage();
    const firstCycle = await measure(()=>h.cycle(f));
    const registryAfter=await registryUsage();
    const registryFirst={reads:registryAfter.reads-registryBefore.reads,writes:registryAfter.writes-registryBefore.writes};
    for(let n=1;n<150;n++)await h.cycle(f);
    const registryLastBefore=await registryUsage();
    const lastCycle = await measure(()=>h.cycle(f));
    const registryLastAfter=await registryUsage();
    const registryLast={reads:registryLastAfter.reads-registryLastBefore.reads,writes:registryLastAfter.writes-registryLastBefore.writes};
    const idleAfter=await measure(idle);
    const admitted=await h.admit(f);
    await h.browser(f,"poll",{waitMs:0});
    await h.browser(f,"reply",{operationId:admitted.operationId,phase:"RUNNING"});
    const active=await measure(idle);
    const status=await measure(()=>h.status(f,String(admitted.operationId)));
    const invalid=await measure(async()=> {
      const r=await stub.fetch("https://internal/api/v1/tab/poll",{method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+"x".repeat(64)},body:JSON.stringify({workspaceId:f.workspaceId,epoch:f.lease.epoch,tabInstanceId:f.lease.tabInstanceId,waitMs:0})});
      assert.equal(r.status,409);
    });
    console.log(JSON.stringify({kind:"sql-budget",idleBefore,idleAfter,active,status,invalid,firstCycle,lastCycle,registryFirst,registryLast}));
    assert.ok(registryLast.reads<=registryFirst.reads+20,"Registry ordinary operation cost must not scale with history");
    assert.ok(lastCycle.reads<=firstCycle.reads+20, "ordinary cycle history must not amplify reads");
    assert.ok(idleAfter.reads<=idleBefore.reads+10, "idle history must not amplify reads");
    assert.ok(idleAfter.reads<=10 && active.reads<=40 && status.reads<=35);
    assert.ok(idleAfter.writes<=2 && active.writes<=2 && invalid.writes===0);
    assert.ok(invalid.reads<=5);
  } finally {await h.close();}
});

test("Registry Activity reads only one page and preserves unresolved overlay",async()=>{
  const h=await createCapacityHarness(1);
  try{
    const f=h.fixtures[0]!;
    for(let n=0;n<150;n++)await h.cycle(f);
    const usage=async()=>await h.internal(h.registry,"/internal/sql-usage",{}) as unknown as {reads:number;writes:number;unmetered:number};
    const before=await usage();
    const page=await h.get("/api/v1/admin/activity");
    const after=await usage();
    assert.equal((page.items as unknown[]).length,100);
    assert.ok(page.cursor);
    assert.equal(after.unmetered,0);
    console.log(JSON.stringify({kind:"registry-activity-budget",reads:after.reads-before.reads,writes:after.writes-before.writes}));
    assert.ok(after.reads-before.reads<=130);
    assert.equal(after.writes-before.writes,0);
    const next=await h.get("/api/v1/admin/activity?cursor="+encodeURIComponent(String(page.cursor)));
    assert.equal((next.items as unknown[]).length,50);
  }finally{await h.close();}
});

test("MCP configuration is scoped to exactly one Agent without scanning others", async()=>{
  const h=await createCapacityHarness(20);
  try {
    const f=h.fixtures[0]!;
    const usage=async()=>await h.internal(h.registry,"/internal/sql-usage",{}) as unknown as {reads:number;writes:number};
    const before=await usage();
    const scoped=await h.internal(h.registry,"/internal/config",{agentId:f.agentId});
    const after=await usage();
    assert.deepEqual(scoped.resources,["https://capacity.test/mcp/"+f.agentId]);
    assert.ok(after.reads-before.reads<=8);
    assert.equal(after.writes-before.writes,0);
    const unknown=await h.internal(h.registry,"/internal/config",{agentId:"nonexistent"});
    assert.deepEqual(unknown.resources,[]);
  } finally {await h.close();}
});
