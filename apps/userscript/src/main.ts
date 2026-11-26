import { APP_VERSION } from "../../../packages/contracts/src/index.js";
import { NativeAdapter } from "./adapter.js";
import { LiveLifecycleReadback, NativeLifecycle } from "./lifecycle.js";
import { resolveNativePageRealm } from "./page-context.js";
import { reconnectCandidate } from "./autoconnect.js";
import { GMStore } from "./storage.js";
import { GatewayTransport, gatewayOrigin } from "./transport.js";
import { BrowserController } from "./controller.js";
import { DocumentDraftStore } from "./resource-drafts.js";
import { RuntimeTools } from "./runtime-tools.js";
import {
  mountManager,
  type ManagerClient,
  type ManagerHandle,
} from "./manager.js";

declare const unsafeWindow: Window;
declare const cloneInto:
  | ((value: unknown, target: unknown) => unknown)
  | undefined;
declare const GM_info: {
  injectInto?: string;
  version?: string;
  scriptHandler?: string;
};
declare function GM_getValue(key: string): unknown;
declare function GM_setValue(key: string, value: unknown): void;
declare function GM_deleteValue(key: string): void;
declare function GM_listValues(): string[];
declare function GM_registerMenuCommand(
  label: string,
  callback: () => void,
): unknown;
declare function GM_setClipboard(text: string): void;

async function start(): Promise<void> {
  if (
    window.top !== window.self ||
    location.origin !== "https://perchance.org" ||
    /^\/(?:ai-agent|upload|login|signup)(?:\/|$)/.test(location.pathname)
  )
    return;
  const store = new GMStore({
    getValue: GM_getValue,
    setValue: GM_setValue,
    deleteValue: GM_deleteValue,
    listValues: GM_listValues,
  });
  const transport = new GatewayTransport(store);
  let initializationError = false;
  try {
    await transport.initialize();
  } catch {
    initializationError = true;
  }
  const page = resolveNativePageRealm(
    window,
    typeof unsafeWindow !== "undefined" ? unsafeWindow : undefined,
  );
  const adapter = new NativeAdapter(page, {
    cloneInto:
      typeof cloneInto === "function" ? (v) => cloneInto(v, page) : undefined,
    // The owner supplied native HAR evidence for Save, Rename and Listing.
    // Gateway policy, Grant, owner/lease and exact readback remain independent.
    externalWritesVerified: true,
  });
  let manager: ManagerHandle | undefined;
  let closing = false;
  let manualConnectionEpoch = 0;
  let connectionQueue: Promise<void> = Promise.resolve();
  const runtime = new RuntimeTools(page, store, document);
  const lifecycle = new NativeLifecycle(adapter,page,
    new LiveLifecycleReadback(adapter),store,{externalWritesVerified:true});
  const controller = new BrowserController(
    adapter,
    store,
    transport,
    runtime,
    (status) => manager?.setStatus(status),
    lifecycle,
    (message) => window.confirm(message),
  );
  const download = (name: string, data: string | Uint8Array, mime: string) => {
    const blob = new Blob(
      [typeof data === "string" ? data : (data.slice().buffer as ArrayBuffer)],
      { type: mime },
    );
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.rel = "noopener";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  };
  // Serialization prevents bootstrap reconnect and an operator click from
  // creating competing leases for the same tab/Workspace.
  const connect = (workspace: Record<string, unknown>, automatic: boolean, epoch: number) => {
    const action = connectionQueue.catch(() => undefined).then(async () => {
      if (closing || (automatic && (manualConnectionEpoch !== epoch))) return;
      const held = controller.diagnostics();
      if ((held.connection === "connected" || held.connection === "degraded") &&
          held.workspaceId === workspace.id && held.leasePresent) return;
      if (typeof GM_info === "undefined" || GM_info.injectInto !== "content")
        throw new Error("Verified isolated Violentmonkey content injection is required.");
      const health = await transport.health() as { schemaVersion?: number };
      if (health.schemaVersion !== 1)
        throw new Error("Gateway protocol/schema incompatible.");
      if (closing || (automatic && manualConnectionEpoch !== epoch)) return;
      await controller.attach(workspace);
    });
    connectionQueue = action.catch(() => undefined);
    return action;
  };
  const client: ManagerClient = {
    request: (method, path, body) => transport.request(method, path, body),
    health: (origin) => transport.health(origin),
    diagnostics: () => ({
      ...transport.diagnostics(),
      browser: controller.diagnostics(),
      preview: runtime.diagnostics(),
    }),
    promptSecret: async (purpose) => {
      if (typeof GM_info === "undefined" || GM_info.injectInto !== "content")
        throw new Error(
          "Verified isolated Violentmonkey content context is required for credential entry.",
        );
      // The native prompt is obtained from the isolated controller Window, never unsafeWindow.
      return window.prompt(
        purpose === "bootstrap"
          ? "Perch MCP: enter the one-time bootstrap secret for the gateway shown in Settings."
          : "Perch MCP: enter the newly rotated recovery secret. Existing Grants and leases will be revoked.",
      );
    },
    pair: (origin, secret) => transport.pair(origin, secret),
    recover: async (origin, secret) => {
      await controller.pause();
      await transport.recover(origin, secret);
    },
    configuration: () => transport.configuration(),
    currentIdentity: async () => ({
      ...(await adapter.identity()),
      browserInstallationId: await transport.installationId(),
    }),
    attach: async (workspace) => {
      manualConnectionEpoch++;
      await connect(workspace, false, manualConnectionEpoch);
      if (typeof workspace.id === "string")
        await store.delete("perch:autoconnect-stop:" + workspace.id);
    },
    pauseLocal: async () => {
      const id = controller.diagnostics().workspaceId;
      // Pause synchronously aborts the local controller before the first
      // asynchronous store write or gateway lease release can stall.
      const release = controller.pause();
      let markerFailed = false;
      if (id) {
        try { await store.set("perch:autoconnect-stop:" + id, true); }
        catch { markerFailed = true; }
      }
      // An auxiliary storage failure cannot defer local admission stop.
      // release() may still await server acknowledgement; it never replays.
      await release;
      if (markerFailed)
        manager?.setStatus({
          connection: "blocked",
          reason: "Stopped locally, but automatic-restart suppression could not be saved. Repair userscript storage before reloading.",
        });
    },
    copy: async (text) => GM_setClipboard(text),
    download,
    drafts: new DocumentDraftStore(store, controller.tabInstanceId),
    localDrafts: () =>
      new DocumentDraftStore(store, controller.tabInstanceId).export(),
    probe: async () => ({
      ...(await adapter.probe()),
      manager: {
        name:
          typeof GM_info === "undefined" ? "unknown" : GM_info.scriptHandler,
        version: typeof GM_info === "undefined" ? "unknown" : GM_info.version,
        injectInto:
          typeof GM_info === "undefined" ? "unknown" : GM_info.injectInto,
      },
      externalVerification: "HAR-confirmed native Save/Rename/Listing enabled by operator; gateway native-actions policy, owner, Grant and exact post-effect readback remain required.",
    }),
    disconnect: async () => {
      await controller.pause();
      await transport.disconnect();
    },
    sourceBackup: () => controller.sourceBackup(),
    reconcileOperation: (operation) => controller.reconcileOperation(operation),
    localRecovery: workspaceId => controller.localRecovery(workspaceId),
    resolveLocalHold: (workspaceId,journalId,expectedRevision,evidence) =>
      controller.resolveLocalHold(workspaceId,journalId,expectedRevision,evidence),
    restoreSourceBackup: (backup) => controller.restoreSourceBackup(backup),
    importSettings: async (settings) => {
      const origin = gatewayOrigin(settings.gatewayOrigin);
      await controller.pause();
      await transport.disconnect();
      await transport.importSettingsOrigin(origin);
    },
    localArtifacts: () => controller.localArtifacts(),
    downloadArtifact: async (id) => {
      const { metadata, bytes } = await controller.artifacts.read(id);
      download(metadata.name, bytes, "application/octet-stream");
    },
    exportResources: () => transport.exportResources(),
    fetchHosts: async () =>
      (await store.get<string[]>("perch:fetch-approved-hosts")) ?? [
        "perchance.org",
        "user.uploads.dev",
      ],
    setFetchHosts: async (hosts) => {
      await store.set("perch:fetch-approved-hosts", hosts);
    },
  };
  manager = mountManager({ version: APP_VERSION, client });
  if (initializationError)
    manager.setStatus({
      connection: "blocked",
      reason:
        "Stored pairing incompatible. Export local data and recover pairing.",
    });
  GM_registerMenuCommand("Open Perch MCP", () => {
    void manager?.open();
  });
  async function resumeBoundEditor(): Promise<void> {
    if (initializationError || !transport.configuration().paired || closing) return;
    const epoch = manualConnectionEpoch;
    manager?.setStatus({
      connection: "connecting",
      reason: "Checking native editor and existing Workspace binding.",
    });
    try {
      let identity: Awaited<ReturnType<NativeAdapter["identity"]>> | undefined;
      // Perchance's editor initializes asynchronously after DOMContentLoaded.
      // Read-only probing is bounded and never changes a Binding or source.
      for (let attempt = 0; attempt < 40; attempt++) {
        if (closing || manualConnectionEpoch !== epoch) return;
        try {
          const probe = await adapter.probe();
          if (probe.ready && probe.identity) { identity = probe.identity; break; }
        } catch { /* unsupported/unready native editor: retry until bounded deadline */ }
        await new Promise<void>((resolve) => setTimeout(resolve, 500));
      }
      if (!identity || closing || manualConnectionEpoch !== epoch) {
        if (!closing && manualConnectionEpoch === epoch)
          manager?.setStatus({
            connection: "offline",
            reason: "Native editor did not become ready within 20 seconds. Use the read-only editor probe.",
          });
        return;
      }
      const remote = await transport.request("GET", "/api/v1/admin/workspaces") as {
        items?: unknown[]; cursor?: string | null;
      };
      // A partial paginated list cannot prove uniqueness; do not guess.
      if (!Array.isArray(remote.items) || remote.cursor)
        throw new Error("Workspace inventory incomplete; select and reconnect explicitly.");
      const candidate = reconnectCandidate(
        remote.items, identity, await transport.installationId(),
      );
      if (closing || manualConnectionEpoch !== epoch) return;
      if (!candidate) {
        manager?.setStatus({
          connection: "offline",
          reason: "No unique, active Workspace Binding matches this generator, draft and paired browser. Select Reconnect explicitly.",
        });
        return;
      }
      if (await store.get<boolean>("perch:autoconnect-stop:" + candidate.id)) {
        manager?.setStatus({
          connection: "paused",
          reason: "The operator stopped this Workspace. Reconnect explicitly to resume.",
        });
        return;
      }
      await connect(candidate, true, epoch);
    } catch (error) {
      if (closing || manualConnectionEpoch !== epoch) return;
      const code = error && typeof error === "object" && "code" in error &&
        typeof error.code === "string" ? error.code : "RECONNECT_FAILED";
      manager?.setStatus({
        connection: ["EFFECT_UNKNOWN","TAB_BUSY"].includes(code) ? "blocked" : "offline",
        workspace: candidate.id,
        reason: code === "EFFECT_UNKNOWN"
          ? "An unresolved Gateway effect prevents a new lease. Open Recovery for the exact held operation. Never repeat the unknown effect or re-pair to clear it."
          : code === "TAB_BUSY"
            ? "A lease or claim is still active. Open Recovery to inspect its expiry and owner-safe next action; do not force takeover."
            : `Automatic reconnect did not complete (${code}). Open Recovery and inspect Gateway and local state.`,
      });
    }
  }
  // Native edit mode is checked inside the adapter; a new page/tab never
  // takes over a current lease or silently changes an existing Binding.
  void resumeBoundEditor();
  window.addEventListener("pagehide", () => {
    closing = true;
    manualConnectionEpoch++;
    connectionQueue = connectionQueue.catch(() => undefined).then(() => controller.pause());
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) {
      closing = false;
      void resumeBoundEditor();
    }
  });
}
if (document.readyState === "loading")
  document.addEventListener(
    "DOMContentLoaded",
    () => {
      void start().catch(() => {
        console.warn("Perch MCP", {
          code: "INITIALIZATION_FAILED",
          recovery:
            "Verify Violentmonkey content injection and reload. Native editing remains available.",
        });
      });
    },
    { once: true },
  );
else
  void start().catch(() => {
    console.warn("Perch MCP", {
      code: "INITIALIZATION_FAILED",
      recovery:
        "Verify Violentmonkey content injection and reload. Native editing remains available.",
    });
  });
