import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { GatewayTransport } from "../../apps/userscript/src/transport.js";
import { BrowserController } from "../../apps/userscript/src/controller.js";
import { MemoryStore } from "../../apps/userscript/src/storage.js";
import { NativeAdapter } from "../../apps/userscript/src/adapter.js";
test(
  "actual controller transports durable read and draft write through local SQLite gateway",
  { timeout: 30000 },
  async () => {
    const result = await build({
      entryPoints: ["apps/gateway/src/index.ts"],
      bundle: true,
      write: false,
      platform: "browser",
      format: "esm",
      target: "es2022",
      external: ["cloudflare:*", "node:*"],
    });
    const issuer = "https://controller.example.workers.dev",
      secret = "synthetic-bootstrap-".padEnd(64, "x");
    const mf = new Miniflare({ cf: false, outboundService: () => { throw new Error("OFFLINE_FIXTURE_NETWORK_DENIED"); },
      modules: true,
      script: result.outputFiles[0]!.text,
      compatibilityDate: "2026-07-30",
      compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
      kvNamespaces: ["OAUTH_KV"],
      durableObjects: {
        REGISTRY: { className: "Registry", useSQLite: true },
        WORKSPACES: { className: "Workspace", useSQLite: true },
      },
      bindings: { BOOTSTRAP_SECRET: secret, ISSUER_URL: issuer },
    });
    const store = new MemoryStore(),
      transport = new GatewayTransport(store, ((
        url: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) =>
        mf.dispatchFetch(
          String(url),
          init as never,
        )) as unknown as typeof fetch);
    let pjs = "output = original";
    const page = {
      app: {
        data: { generator: { id: "fixture-generator", name: "fixture" } },
      },
      aiAgentActivityState: () => ({
        active: false,
        unknown: false,
        reason: "",
        queueHeldOnly: false,
      }),
      __aiGeneratorGuard: { blocked: () => false },
      __editorReady: true,
      __draftChoiceSettled: true,
      currentInterfaceMode: "edit",
      nativeHelperBusy: false,
      collaborationUnsynced: false,
      modelTextEditor: {
        state: { readOnly: false },
        getValue: () => pjs,
        setValue: (s: string) => {
          pjs = s;
        },
      },
      outputTemplateEditor: {
        state: { readOnly: false },
        getValue: () => "<p>[output]</p>",
        setValue: () => {},
      },
      srcState: {
        ready: async () => {},
        idle: async () => {},
        getDraftId: () => "",
        list: () => ({}),
        readFile: async () => new Uint8Array(),
        writeFile: async () => {},
        deleteFile: async () => {},
      },
    };
    const controller = new BrowserController(
      new NativeAdapter(page),
      store,
      transport,
    );
    try {
      await transport.pair(issuer, secret);
      const w = (await transport.request("POST", "/api/v1/admin/workspaces", {
        label: "Controller fixture",
      })) as Record<string, unknown>;
      const binding = {
        generatorId: "fixture-generator",
        slug: "fixture",
        draftId: "",
        browserInstallationId: await transport.installationId(),
      };
      const bound = (await transport.request("POST", `/api/v1/admin/workspaces/${w.id}/bind`, {
        expectedRevision: w.revision,
        binding,
      })) as Record<string, unknown>;
      const a = (await transport.request("POST", "/api/v1/admin/agents", {
        workspaceId: w.id,
        label: "Controller Agent",
      })) as Record<string, unknown>;
      const ns = await mf.getDurableObjectNamespace("REGISTRY"),
        registry = ns.get(ns.idFromName("installation"));
      const wsns = await mf.getDurableObjectNamespace("WORKSPACES"),
        workspace = wsns.get(wsns.idFromName(String(w.id)));
      async function internal(
        stub: { fetch: typeof registry.fetch },
        path: string,
        body: unknown,
      ) {
        const r = await stub.fetch("https://internal" + path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const value = (await r.json()) as Record<string, unknown>;
        assert.equal(r.status, 200, JSON.stringify(value));
        return value;
      }
      // Trusted authorization-server fixture; actual PKCE/token exchange is tested separately in gateway.test.ts.
      const pending = await internal(registry, "/internal/oauth/pending", {
        request: {
          clientId: "synthetic-client",
          redirectUri: "https://client.test/callback",
          scope: ["mcp"],
          resource: a.endpoint,
          responseType: "code",
          state: "fixture",
          codeChallenge: "fixture",
          codeChallengeMethod: "S256",
        },
      });
      const list = (await transport.request(
        "GET",
        "/api/v1/admin/approvals",
      )) as { items: Record<string, unknown>[] };
      const approval = list.items.find((x) => x.id === pending.id)!;
      await transport.request(
        "POST",
        `/api/v1/admin/approvals/${pending.id}/decision`,
        {
          expectedRevision: approval.revision,
          digest: approval.digest,
          decision: "approve",
        },
      );
      const grant = await internal(registry, "/internal/oauth/consume", {
        id: pending.id,
        handle: pending.handle,
      });
      await controller.attach(bound);
      async function call(
        tool: string,
        args: Record<string, unknown>,
        permissions: string[],
        mutating: boolean,
      ) {
        const authorized = await internal(registry, "/internal/authorize", {
          props: grant.props,
          agentId: a.id,
          permissions,
          mutating,
        });
        const op = await internal(workspace, "/internal/admit", {
          workspace: authorized.workspace,
          props: grant.props,
          agentId: a.id,
          tool,
          args,
          permissions: [
            "READ_SOURCE",
            "WRITE_SOURCE",
            "READ_RESOURCES",
            "PREVIEW_CONTROL",
          ],
          requiredPermissions: permissions,
          mutating,
        });
        let terminal: Record<string, unknown> = {};
        for (let i = 0; i < 500; i++) {
          terminal = await internal(workspace, "/internal/status", {
            workspaceId: w.id,
            operationId: op.operationId,
          });
          if (
            ["SUCCEEDED", "REJECTED", "PARTIAL", "UNKNOWN"].includes(
              String(terminal.status),
            )
          )
            return terminal;
          await new Promise((r) => setTimeout(r, 10));
        }
        throw new Error("Controller operation timed out.");
      }
      const read = await call(
        "read",
        { path: "main.pjs" },
        ["READ_SOURCE"],
        false,
      );
      assert.equal(read.status, "SUCCEEDED");
      assert.match(JSON.stringify(read), /output = original/);
      const write = await call(
        "write",
        { path: "main.pjs", content: "output = changed" },
        ["WRITE_SOURCE"],
        true,
      );
      assert.equal(write.status, "SUCCEEDED", JSON.stringify(write));
      assert.equal(pjs, "output = changed");
    } finally {
      await controller.pause();
      await mf.dispose();
    }
  },
);

test('bundled v2 controller obtains one permit and publishes through the real local MCP and scoped lease', {timeout:30000}, async()=>{
  const { createCapacityHarness }=await import('./gateway-capacity-harness.js');
  const { issueSyntheticToken, syntheticMcp }=await import('../fixtures/optimization-client.js');
  const h=await createCapacityHarness(1,{DEVELOPMENT_CONTRACT_V2_ENABLED:'true',DEVELOPMENT_CONTRACT_V2_EXECUTION_ENABLED:'true'});
  const f=h.fixtures[0]!;
  const admin='/api/v1/admin';
  const store=new MemoryStore();
  await store.set('perch:pairing',h.syntheticPairing());
  await store.set("perch:installation-id","capacity-browser");
  const transport=new GatewayTransport(store,((url: Parameters<typeof fetch>[0],init?:Parameters<typeof fetch>[1])=>
    h.mf.dispatchFetch(String(url),init as never)) as unknown as typeof fetch);
  await transport.initialize();
  const { default: vm }=await import('node:vm');
  const bundled=await build({stdin:{contents:`export {BrowserController} from './apps/userscript/src/controller.ts';
    export {NativeAdapter} from './apps/userscript/src/adapter.ts';`,resolveDir:process.cwd()},
    bundle:true,write:false,format:'iife',globalName:'V2Fixture',platform:'browser',target:'firefox128'});
  const realm=vm.createContext({TextEncoder,TextDecoder,crypto,console,fetch:()=>{throw new Error('NO_NETWORK');},
    setTimeout,clearTimeout,setInterval,clearInterval,AbortController,AbortSignal,structuredClone,atob,btoa,URL,
    Uint8Array,ArrayBuffer});
  vm.runInContext(bundled.outputFiles[0]!.text,realm);
  const {BrowserController:Controller,NativeAdapter:Adapter}=realm.V2Fixture as
    {BrowserController:typeof BrowserController;NativeAdapter:typeof NativeAdapter};
  const adapter=new Adapter({
    app:{data:{generator:{id:f.binding.generatorId!,name:f.binding.slug!}}},
    modelTextEditor:{state:{readOnly:false},getValue:()=> 'fixture',setValue:()=>undefined},
    outputTemplateEditor:{state:{readOnly:false},getValue:()=>'',setValue:()=>undefined},
    srcState:{ready:async()=>undefined,idle:async()=>undefined,getDraftId:()=>'',list:()=>[],
      readFile:()=>new Uint8Array(),writeFile:()=>undefined,deleteFile:()=>undefined},
    __editorReady:true,__draftChoiceSettled:true,currentInterfaceMode:'edit',
    aiAgentActivityState:()=>({active:false,unknown:false,reason:''}),__aiGeneratorGuard:{blocked:()=>false},
  });
  const controller=new Controller(adapter,store,transport);
  try {
    const current=await h.get(admin+'/workspaces/'+f.workspaceId);
    const a=await h.get(admin+'/agents/'+f.agentId);
    const upgraded=await h.request(admin+'/connectors/'+f.agentId+'/upgrade',{
      expectedRevision:a.revision,expectedWorkspaceRevision:current.revision,acknowledgeReauthorization:true,
    });
    const w=upgraded.workspace as Record<string,unknown>;
    await controller.attach(w);
    const target='w2.'+w.id+'.'+w.assignmentGeneration+'.'+w.bindingGeneration;
    const token=await issueSyntheticToken(h,f);
    const operationKey='k2.'+Date.now()+'.'+crypto.randomUUID();
    const args={target,operationKey,files:[{path:'scratch/fixture.txt',encoding:'utf8',content:'fixture',ifAbsent:true}]};
    const admitted=await syntheticMcp(h,f,token,'write',args);
    assert.ok(admitted.operationId);
    let last:Record<string,unknown>={};
    for(let attempt=0;attempt<120;attempt++){
      last=await syntheticMcp(h,f,token,'operation_status',{target,operationKey});
      if(last.phase==='SUCCEEDED')break;
      if(['REJECTED','PARTIAL','UNKNOWN'].includes(String(last.phase)))break;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.equal(last.phase,'SUCCEEDED',JSON.stringify({last,controller:controller.diagnostics()}));
    const replay=await syntheticMcp(h,f,token,'write',args);
    assert.equal(replay.operationId,admitted.operationId);
    const keys=await store.list();
    assert.ok(keys.some(key=>key.includes(':binding-v2:')&&key.endsWith(':root:local')));
    assert.ok(!keys.some(key=>key.startsWith('perch:workspace:'+w.id+':')));
  } finally {
    await controller.pause();
    await h.close();
  }
});
