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
    const mf = new Miniflare({
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
      await transport.request("POST", `/api/v1/admin/workspaces/${w.id}/bind`, {
        expectedRevision: w.revision,
        binding,
      });
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
      await controller.attach(w);
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
