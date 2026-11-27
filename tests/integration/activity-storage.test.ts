import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

test("real workerd canonical Activity counters stay bounded at capacity and deep keyset pages seek", async () => {
  const bundle = await build({
    stdin: { resolveDir: process.cwd(), contents: `
      import {SqlRecords} from './apps/gateway/src/sql.ts';
      import {CanonicalActivity} from './apps/gateway/src/activity-storage.ts';
      export class ActivityFixture {
        constructor(state){this.state=state;this.db=new SqlRecords(state.storage);this.store=new CanonicalActivity(this.db)}
        async fetch(request){
          const path=new URL(request.url).pathname;
          const body=request.method==='POST'?await request.json():{};
          if(path==='/usage')return Response.json(this.db.snapshotUsage());
          if(path==='/advance')return Response.json(this.store.advance(body.mode??'native',body.limit??32));
          if(path==='/append'){for(const event of body.events)this.store.append(event);return Response.json(this.store.status())}
          if(path==='/page')return Response.json(this.store.page(body.cursor??null,body.status??null,body.workspace??null,body.revision??1));
          if(path==='/explain')return Response.json(this.db.query('EXPLAIN QUERY PLAN SELECT base,notice FROM canonical_activity_v2 WHERE (rank,sort_time,key)>(?,?,?) ORDER BY rank,sort_time,key LIMIT 101',1,-200,'w/operation-200'));
          if(path==='/cold'){this.db=new SqlRecords(this.state.storage);this.store=new CanonicalActivity(this.db);return Response.json(this.store.status())}
          return new Response('not found',{status:404});
        }
      }
      export default {fetch(request,env){return env.ACTIVITY.get(env.ACTIVITY.idFromName('synthetic')).fetch(request)}};
    ` },
    bundle: true, write: false, format: "esm", platform: "browser", target: "es2022",
    external: ["cloudflare:*", "node:*"], conditions: ["workerd", "worker", "browser"],
  });
  let externalRequests = 0;
  const mf = new Miniflare({
    modules: true, script: bundle.outputFiles[0]!.text,
    cf: false,
    compatibilityDate: "2026-07-30", compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
    durableObjects: { ACTIVITY: { className: "ActivityFixture", useSQLite: true } },
    outboundService: () => { externalRequests++; return new Response("External network disabled in fixture", { status: 503 }); },
  });
  type Usage = { reads: number; writes: number; unmetered: number; statements: number };
  try {
    await mf.ready;
    const request = async (path: string, body?: unknown) => {
      const response = await mf.dispatchFetch("https://activity.test" + path, body === undefined ? {} : {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      assert.equal(response.status, 200);
      return response.json() as Promise<Record<string, unknown>>;
    };
    let stage = "LEGACY";
    for (let n = 0; stage !== "NATIVE"; n++) {
      assert.ok(n < 20);
      stage = String((await request("/advance", {})).stage);
    }
    const usage = async () => await request("/usage") as unknown as Usage;
    const measure = async (run: () => Promise<unknown>) => {
      const before = await usage(); await run(); const after = await usage();
      assert.ok(after.statements >= before.statements, "no eviction/reset may masquerade as lower usage");
      assert.equal(after.unmetered, 0);
      return { reads: after.reads - before.reads, writes: after.writes - before.writes };
    };
    const event = (n: number) => ({ workspaceId: "workspace", operationId: "operation-" + n.toString().padStart(6, "0"), phase: "SUCCEEDED", timestamp: n, tool: "read", epoch: 1, bindingRevision: 1 });
    let next = 0;
    const append: Record<string, { reads: number; writes: number }> = {};
    for (const history of [0, 150, 999, 1000]) {
      while (next < history) {
        const count = Math.min(64, history - next), events = Array.from({ length: count }, (_, offset) => event(next + offset));
        await request("/append", { events }); next += count;
      }
      append[history] = await measure(() => request("/append", { events: [event(next++)] }));
    }
    assert.equal(append[0]!.writes, append[150]!.writes);
    assert.equal(append[150]!.writes, append[999]!.writes);
    assert.ok(append[1000]!.reads <= 8 && append[1000]!.writes <= 20);
    const pages: { reads: number; writes: number }[] = [];
    let cursor: unknown = null;
    const ids: string[] = [];
    for (let n = 0; n < 10; n++) {
      pages.push(await measure(async () => {
        const page = await request("/page", { cursor }); cursor = page.cursor;
        ids.push(...(page.items as { operationId: string }[]).map(item => item.operationId));
      }));
    }
    assert.equal(cursor, null);
    assert.equal(ids.length, 1000); assert.equal(new Set(ids).size, 1000);
    // The pinned cursor counts one boundary seek on continuation, in addition to
    // 101 candidate rows and the canonical revision row. The contract budget is 110.
    assert.ok(pages.every(page => page.reads <= 103 && page.writes === 0), JSON.stringify(pages));
    const plan = await request("/explain") as unknown as { detail: string }[];
    assert.ok(plan.some(row => /SEARCH canonical_activity_v2 USING INDEX canonical_activity_order_v2/.test(row.detail)));
    const cold = await request("/cold");
    assert.equal(cold.authority, "native");
    const coldPage = await request("/page", {});
    assert.equal((coldPage.items as unknown[]).length, 100);
    assert.equal(externalRequests, 0);
    console.log(JSON.stringify({ kind: "canonical-activity-workerd", append, pages, externalRequests }));
  } finally { await mf.dispose(); }
});
