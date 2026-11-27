import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { SqlRecords } from "../../apps/gateway/src/sql.js";
import { Registry } from "../../apps/gateway/src/registry.js";
import { Workspace } from "../../apps/gateway/src/workspace.js";
import type {
  DurableObjectStorage,
  DurableObjectState,
} from "@cloudflare/workers-types";
import type { Env } from "../../apps/gateway/src/common.js";
function fixture() {
  const db = new DatabaseSync(":memory:");
  let alarm: number | null = null;
  const storage = {
    async getAlarm() {
      return alarm;
    },
    async setAlarm(value: number | Date) {
      alarm = Number(value);
    },
    async deleteAlarm() {
      alarm = null;
    },
    sql: {
      exec(sql: string, ...args: (string | number)[]) {
        const statement = db.prepare(sql);
        const rows = sql.trim().startsWith("SELECT")
          ? statement.all(...args)
          : (statement.run(...args), []);
        return { toArray: () => rows };
      },
    },
    transactionSync<T>(fn: () => T) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as DurableObjectStorage;
  return { db, storage, state: { storage } as DurableObjectState };
}
test("SQLite chunks preserve Unicode at boundaries and rollback atomically", () => {
  const f = fixture();
  try {
    const records = new SqlRecords(f.storage);
    const value = {
      body: "a".repeat(31990) + "😀".repeat(40000),
      empty: "",
      bytes: [0, 255, 1, 128, 10],
    };
    records.transaction(() => records.put("resource", value));
    assert.deepEqual(records.get("resource"), value);
    assert.throws(() =>
      records.transaction(() => {
        records.put("resource", { body: "changed" });
        records.put("other", true);
        throw new Error("fixture rollback");
      }),
    );
    assert.deepEqual(records.get("resource"), value);
    assert.deepEqual(records.keys("other"), []);
  } finally {
    f.db.close();
  }
});
test("newer Registry/Workspace schemas reject downgrade without rewriting data", async () => {
  const f = fixture();
  try {
    const records = new SqlRecords(f.storage);
    records.put("core", { schemaVersion: 2, revision: 1 });
    const registry = new Registry(f.state, {} as Env);
    const response = await registry.fetch(
      new Request("https://internal/internal/health"),
    );
    assert.equal(response.status, 409);
    assert.equal(
      (records.get("core") as { schemaVersion: number }).schemaVersion,
      2,
    );
    records.put("schema", 2);
    assert.throws(() => new Workspace(f.state, {} as Env), /schema is newer/);
    assert.equal(records.get("schema"), 2);
  } finally {
    f.db.close();
  }
});
test("operational entity budgets validate exact positive integers", async () => {
  const { configuredBudget } = await import("../../apps/gateway/src/common.js");
  assert.equal(configuredBudget(undefined, 1000), 1000);
  assert.equal(configuredBudget("1", 1000), 1);
  assert.equal(configuredBudget("100000", 1000), 100000);
  for (const value of ["0", "-1", "1.5", "NaN", "100001", "01"])
    assert.throws(() => configuredBudget(value, 1000));
});
test("operation handles preserve120s compute/preview/fetch/media defaults and explicit valid deadlines", async () => {
  const { operationTimeoutMs } = await import(
    "../../apps/gateway/src/common.js"
  );
  for (const tool of [
    "page_eval",
    "execute_js",
    "fetch_url",
    "generate_image",
    "upload_file",
  ])
    assert.equal(operationTimeoutMs(tool, {}), 120000);
  assert.equal(operationTimeoutMs("generate_music", {}), 600000);
  assert.equal(operationTimeoutMs("read", {}), 30000);
  assert.equal(operationTimeoutMs("page_eval", { timeoutMs: 500000 }), 500000);
  assert.equal(
    operationTimeoutMs("execute_js", { timeoutMs: 3600000 }),
    3600000,
  );
  assert.equal(operationTimeoutMs("fetch_url", { timeoutMs: 1000 }), 1000);
  assert.throws(() => operationTimeoutMs("page_eval", { timeoutMs: 500001 }));
  assert.throws(() => operationTimeoutMs("execute_js", { timeoutMs: 0 }));
});

function opFixture(phase = "RUNNING") {
  return {
    operationId: "fixture-operation",
    sequence: 1,
    argsDigest: "fixture-digest",
    workspaceId: "fixture-workspace",
    epoch: 1,
    bindingRevision: 1,
    tabInstanceId: "fixture-tab",
    deadlineMs: Date.now() - 1,
    tool: phase === "UNKNOWN" ? "generate_music" : "read",
    args: { source: "never-log-fixture-source" },
    permissions: ["READ_SOURCE"],
    requiredPermissions: ["READ_SOURCE"],
    mutating: false,
    props: {
      grantId: "fixture-grant",
      agentId: "fixture-agent",
      workspaceId: "fixture-workspace",
      bindingRevision: 1,
    },
    agentId: "fixture-agent",
    traceId: "fixture-trace",
    phase,
    createdAt: Date.now() - 100,
    ...(phase === "UNKNOWN"
      ? {
          terminalAt: Date.now(),
          result: {
            operationId: "fixture-operation",
            status: "UNKNOWN",
            effectState: "POSSIBLE",
            error: { code: "EFFECT_UNKNOWN", message: "fixture" },
          },
        }
      : {}),
  };
}
test("terminal outbox survives receipt loss and instance restart without duplicate Activity or revision bump", async () => {
  const local = fixture(),
    authority = fixture();
  try {
    const localDb = new SqlRecords(local.storage),
      registryDb = new SqlRecords(authority.storage);
    registryDb.put("workspace/fixture-workspace", {
      id: "fixture-workspace",
      binding: null,
    });
    const reg = new Registry(authority.state, {} as Env);
    let loseReceipt = true,
      calls = 0;
    const env = {
      REGISTRY: {
        idFromName: () => "installation",
        get: () => ({
          fetch: async (request: Request) => {
            calls++;
            const response = await reg.fetch(request);
            if (loseReceipt) throw new Error("lost metadata receipt");
            return response;
          },
        }),
      },
    } as unknown as Env;
    localDb.put("operation/fixture-operation", opFixture());
    const request = () =>
      new Request("https://internal/internal/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: "fixture-workspace",
          operationId: "fixture-operation",
        }),
      });
    const first = await new Workspace(local.state, env).fetch(request());
    assert.equal(
      ((await first.json()) as { status: string }).status,
      "UNKNOWN",
    );
    assert.equal(
      localDb.get<{ terminalNotified?: boolean }>("operation/fixture-operation")
        .terminalNotified,
      undefined,
    );
    assert.ok((await local.storage.getAlarm())! > Date.now());
    const revision = registryDb.get<{ revision: number }>("core").revision;
    loseReceipt = false;
    const restarted = new Workspace(local.state, env);
    await restarted.fetch(request());
    assert.equal(
      localDb.get<{ terminalNotified: boolean }>("operation/fixture-operation")
        .terminalNotified,
      true,
    );
    assert.equal(
      registryDb.get<{ revision: number }>("core").revision,
      revision,
    );
    assert.equal(registryDb.get<unknown[]>("activity").length, 1);
    const event = registryDb.get<Record<string, unknown>[]>("activity")[0]!;
    assert.equal(event.errorCode, "EFFECT_UNKNOWN");
    assert.equal(event.traceId, "fixture-trace");
    assert.equal(event.phase, "UNKNOWN");
    assert.equal(event.epoch, 1);
    assert.ok(!JSON.stringify(event).includes("never-log-fixture-source"));
    assert.equal(calls, 2);
  } finally {
    local.db.close();
    authority.db.close();
  }
});
test("deadline alarm and provider-written UNKNOWN both publish durable redacted recovery notices", async () => {
  for (const phase of ["RUNNING", "UNKNOWN"]) {
    const local = fixture(),
      authority = fixture();
    try {
      const localDb = new SqlRecords(local.storage),
        registryDb = new SqlRecords(authority.storage);
      registryDb.put("workspace/fixture-workspace", {
        id: "fixture-workspace",
        binding: null,
      });
      const reg = new Registry(authority.state, {} as Env),
        env = {
          REGISTRY: {
            idFromName: () => "installation",
            get: () => ({ fetch: (request: Request) => reg.fetch(request) }),
          },
        } as unknown as Env;
      localDb.put("operation/fixture-operation", opFixture(phase));
      await new Workspace(local.state, env).alarm();
      const event =
        registryDb.get<{ phase: string; errorCode: string }[]>("activity")[0]!;
      assert.equal(event.phase, "UNKNOWN");
      assert.equal(event.errorCode, "EFFECT_UNKNOWN");
      assert.equal(
        localDb.get<{ terminalNotified: boolean }>(
          "operation/fixture-operation",
        ).terminalNotified,
        true,
      );
    } finally {
      local.db.close();
      authority.db.close();
    }
  }
});
test("Activity preserves an old unresolved hold beyond the rolling terminal window", async () => {
  const authority = fixture();
  try {
    const db = new SqlRecords(authority.storage),
      { digest } = await import("../../apps/gateway/src/common.js");
    const credential = "activity-test-".padEnd(64, "x");
    db.put("core", {
      schemaVersion: 1,
      revision: 3,
      policyRevision: 1,
      paused: false,
      issuer: "https://unit.test",
      paired: true,
      adminHash: await digest(credential),
      executionHash: "fixture",
      browserInstallationId: "fixture",
      credentialEpoch: 1,
    });
    const event = {
      operationId: "old-unknown",
      workspaceId: "fixture-workspace",
      tool: "save_generator",
      phase: "UNKNOWN",
      epoch: 4,
      bindingRevision: 2,
      traceId: "old-trace",
      timestamp: 1,
      errorCode: "EFFECT_UNKNOWN",
      durationMs: 3,
    };
    db.put("terminal-notice/fixture-workspace/old-unknown", {
      phase: "UNKNOWN",
      expires: 1,
      event,
    });
    db.put(
      "activity",
      Array.from({ length: 1000 }, (_, i) => ({
        operationId: "new-" + i,
        workspaceId: "other",
        tool: "read",
        phase: "SUCCEEDED",
        timestamp: Date.now() + i,
      })),
    );
    const registry = new Registry(authority.state, {} as Env);
    const response = await registry.fetch(
      new Request("https://internal/api/v1/admin/activity", {
        headers: { Authorization: "Bearer " + credential },
      }),
    );
    assert.equal(response.status, 200);
    const result = (await response.json()) as {
      items: (typeof event)[];
      cursor: string;
    };
    assert.equal(result.items[0]!.operationId, "old-unknown");
    assert.equal(result.items[0]!.epoch, 4);
    assert.ok(result.cursor);
  } finally {
    authority.db.close();
  }
});

test("Registry safely repairs exactly a legacy terminal viewport writer reservation, never a provider/source reservation",async()=>{
  const f=fixture();
  try {
    const rows=new SqlRecords(f.storage);
    const {digest}=await import('../../apps/gateway/src/common.js');
    const credential='legacy-fixture-execution-credential';
    const base={
      schemaVersion:1,revision:12,policyRevision:1,paused:false,issuer:'https://gateway.test',
      paired:true,credentialEpoch:1,executionHash:await digest(credential),
      browserInstallationId:'fixture-browser'
    };
    rows.put('core',base);
    const binding={generatorId:'generator-42',slug:'fixture',draftId:'',
      browserInstallationId:'fixture-browser'};
    rows.put('workspace/fixture-w',{
      id:'fixture-w',label:'Fixture',revision:4,bindingRevision:1,epoch:5,
      permissions:['READ_SOURCE','WRITE_SOURCE'],paused:false,binding
    });
    const claim=()=>new Request('https://internal/internal/claim',{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
        credential,workspaceId:'fixture-w',binding
      })
    });
    const api=new Registry(f.state,{ISSUER_URL:'https://gateway.test'} as Env);
    const hold={workspaceId:'fixture-w',operationId:'old-viewport'};
    rows.put('reservation/generator-42',hold);
    rows.put('terminal-notice/fixture-w/old-viewport',{
      phase:'PARTIAL',expires:Date.now()+86400000,
      event:{operationId:'old-viewport',workspaceId:'fixture-w',tool:'set_viewport_size',
        phase:'PARTIAL',epoch:5,bindingRevision:1}
    });
    assert.equal((await api.fetch(claim())).status,200);
    assert.equal(rows.get('reservation/generator-42'),undefined);
    assert.equal((rows.get('terminal-notice/fixture-w/old-viewport') as {phase:string}).phase,
      'PARTIAL','historical uncertainty survives safe lock release');
    for(const mismatch of [
      {tool:'save_generator',phase:'PARTIAL'},
      {tool:'set_viewport_size',phase:'UNKNOWN'},
      {tool:'set_viewport_size',phase:'PARTIAL',bindingRevision:2},
    ]){
      rows.put('reservation/generator-42',hold);
      rows.put('terminal-notice/fixture-w/old-viewport',{
        phase:'PARTIAL',expires:Date.now()+86400000,
        event:{operationId:'old-viewport',workspaceId:'fixture-w',
          tool:mismatch.tool,phase:mismatch.phase,epoch:5,
          bindingRevision:mismatch.bindingRevision??1}
      });
      assert.equal((await api.fetch(claim())).status,200);
      assert.deepEqual(rows.get('reservation/generator-42'),hold,
        'ambiguous or provider reservation cannot be cleared');
    }
  } finally{f.db.close();}
});


test('HAR-native policy admits exactly Save, Rename and Listing; cannot widen provider privileges',async()=>{
 const {permitsHarNativeAction,HAR_NATIVE_ACTIONS}=await import('../../apps/gateway/src/common.js');
 const enabled={NATIVE_ACTIONS_ENABLED:'true'};
 const disabled={NATIVE_ACTIONS_ENABLED:'false'};
 const examples:[string,string[]][]=[
   ['save_generator',['READ_SOURCE','SAVE']],
   ['rename_generator',['RENAME']],
   ['set_listing',['LISTING']],
 ];
 assert.deepEqual(Object.keys(HAR_NATIVE_ACTIONS).sort(),
   examples.map(([tool])=>tool).sort());
 for(const [tool,permissions]of examples){
  assert.equal(permitsHarNativeAction(enabled,tool,permissions),true,tool);
  assert.equal(permitsHarNativeAction(disabled,tool,permissions),false,tool);
  assert.equal(permitsHarNativeAction(enabled,tool,['READ_SOURCE']),false,tool);
  assert.equal(permitsHarNativeAction(enabled,tool,[...permissions,'DELETE']),false,tool);
 }
 for(const tool of ['delete_generator','create_generator','duplicate_generator',
   'generate_music','generate_image','upload_file','upload_server_plugin_state',
   'download_server_plugin_state','__proto__','constructor']){
  assert.equal(permitsHarNativeAction(enabled,tool,['SAVE','RENAME','LISTING']),false,tool);
 }
 assert.equal(permitsHarNativeAction(enabled,'save_generator',['SAVE','MEDIA']),false);
 assert.equal(permitsHarNativeAction(enabled,'set_listing',['LISTING','PRODUCTION_RESTORE']),false);
});

test('read-only Workspace Recovery distinguishes active lease, running and uncertain operations without secrets',async()=>{
 const f=fixture();
 try{
   const db=new SqlRecords(f.storage),now=Date.now();
   db.put('lease',{workspaceId:'fixture-workspace',epoch:7,bindingRevision:2,
     tabInstanceId:'private-tab',secretHash:'never-visible-lease-secret',
     expiresAt:now+90000,credentialEpoch:1,permissions:['READ_SOURCE']});
   const running={...opFixture('RUNNING'),operationId:'running-work',
     phase:'RUNNING',deadlineMs:now+120000,terminalAt:undefined};
   const unknown={...opFixture('UNKNOWN'),operationId:'unknown-work',
     tool:'save_generator',phase:'UNKNOWN',terminalNotified:true,terminalAt:now};
   db.put('operation/running-work',running);db.put('operation/unknown-work',unknown);
   const inspect=async()=>{
     const response=await new Workspace(f.state,{} as Env).fetch(
       new Request('https://internal/internal/recovery',{
         method:'POST',headers:{'content-type':'application/json'},
         body:JSON.stringify({workspaceId:'fixture-workspace'})}));
     assert.equal(response.status,200);return response.json() as Promise<{
       activeLease:null|{epoch:number;expiresAt:number};action:string;
       blockingOperations:{operationId:string;resolvable:boolean;phase:string}[];
     }>;
   };
   let result=await inspect();assert.equal(result.action,'RECONCILE');
   assert.equal(result.activeLease?.epoch,7);
   assert.deepEqual(result.blockingOperations.map(x=>[x.operationId,x.resolvable]),
     [['running-work',false],['unknown-work',true]]);
   assert.doesNotMatch(JSON.stringify(result),/never-visible|private-tab|never-log-fixture-source|fixture-grant/);
   db.put('operation/unknown-work',{...unknown,resolution:{resolvedByOperator:true}});
   result=await inspect();assert.equal(result.action,'WAIT_FOR_TERMINAL');
   db.put('operation/running-work',{...running,phase:'SUCCEEDED',terminalAt:now,terminalNotified:true});
   result=await inspect();assert.equal(result.action,'WAIT_FOR_LEASE');
   db.delete('lease');result=await inspect();assert.equal(result.action,'RECONNECT');
   assert.equal(result.blockingOperations.length,0);
 } finally{f.db.close();}
});

test("corrupt SQLite record is reported without replacing canonical state", () => {
  const f=fixture();
  try {
    const records=new SqlRecords(f.storage);
    f.storage.sql.exec("INSERT INTO records(key,part,value) VALUES(?,?,?)", "core", 0, "{invalid-json");
    assert.throws(()=>records.get("core"),/SQLITE_RECORD_CORRUPT/);
    const untouched=f.storage.sql.exec<{value:string}>("SELECT value FROM records WHERE key=?", "core").toArray();
    assert.equal(untouched[0]?.value, "{invalid-json");
  } finally {f.db.close();}
});
