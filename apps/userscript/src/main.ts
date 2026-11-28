import { exportWorkspaceEvidence } from './binding-storage.js';
import { APP_VERSION } from "../../../packages/contracts/src/index.js";
import { NativeAdapter } from "./adapter.js";
import { LiveLifecycleReadback, NativeLifecycle } from "./lifecycle.js";
import { resolveNativePageRealm } from "./page-context.js";
import { reconnectCandidate } from "./autoconnect.js";
import { isRetryableGatewayFailure } from "./connection-failures.js";
import { GMStore } from "./storage.js";
import { digest } from "./native-types.js";
import { GatewayTransport, TransportError, gatewayOrigin } from "./transport.js";
import { BrowserController } from "./controller.js";
import { DocumentDraftStore } from "./resource-drafts.js";
import { RuntimeTools } from "./runtime-tools.js";
import {
  mountManager,
  type ManagerClient,
  type ManagerHandle,
  type WorkspaceTransitionReceipt,
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
  const receiptId = /^[0-9a-f-]{36}$/;
  const transitionActions = new Set(["assign", "detach", "rebind", "transfer", "unassign"]);
  async function transitionPrefix() {
    const config = transport.configuration();
    if (!config.paired || !config.browserInstallationId)
      throw new Error("Pairing identity is unavailable.");
    return "perch:manager-transition:" + await digest(JSON.stringify([config.origin, config.browserInstallationId])) + ":";
  }
  async function transitionKeys(prefix: string) {
    const keys = (await store.list()).filter(key => key.startsWith(prefix)).sort();
    if (keys.length > 100) throw new Error("Retained transition records exceed the inspection limit.");
    return keys;
  }
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
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectAttempt = 0;
  let reconnectWorkspace: string | undefined;
  let bootstrapPhase = 'INIT';
  let bootstrapCode: string | null = null;
  let bootstrapConnectivityRetryable: boolean | null = null;
  let bootstrapWorkspace: string | null = null;
  let bootstrapTimer: ReturnType<typeof setTimeout> | undefined;
  let bootstrapRunning = false;
  let bootstrapRetryAttempt = 0;
  function retryNativeBootstrap():void{
    if(closing || bootstrapTimer || !transport.configuration().paired)return;
    const base=Math.min(60000,2000*2**Math.min(bootstrapRetryAttempt++,5));
    const delay=Math.max(transport.connectivityRetryDelayMs(),base+Math.floor(Math.random()*Math.min(1000,base/4)));
    bootstrapTimer=setTimeout(()=>{
      bootstrapTimer=undefined;
      if(controller.diagnostics().leasePresent)return;
      void resumeBoundEditor();
    },delay);
    (bootstrapTimer as unknown as {unref?:()=>void}).unref?.();
  }
  const clearReconnect = () => {
    if(reconnectTimer)clearTimeout(reconnectTimer);
    reconnectTimer=undefined;
  };
  const runtime = new RuntimeTools(page, store, document);
  const lifecycle = new NativeLifecycle(adapter,page,
    new LiveLifecycleReadback(adapter),store,{externalWritesVerified:true});
  const controller = new BrowserController(
    adapter,
    store,
    transport,
    runtime,
    (status) => {
      manager?.setStatus(status);
      if(status.connection==='connected'){
        bootstrapRetryAttempt=0;
        clearReconnect();reconnectAttempt=0;reconnectWorkspace=undefined;
      }else if(status.connection==='offline' &&
        isRetryableGatewayFailure(controller.diagnostics().reasonCode??'',
          controller.diagnostics().connectivityRetryable ?? undefined) &&
        status.workspace && !closing){
        reconnectWorkspace=status.workspace;
        scheduleReconnect();
      }else if(status.connection==='blocked' || status.connection==='paused'){
        clearReconnect();
      }
    },
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
      if (closing || manualConnectionEpoch !== epoch)
        throw Object.assign(new Error('Connection request was superseded by Stop or a newer request.'),{code:'CONNECTION_CANCELLED'});
      const held = controller.diagnostics();
      if ((held.connection === "connected" || held.connection === "degraded") &&
          held.workspaceId === workspace.id && held.leasePresent &&
          (workspace.contractVersion !== 2 ||
            held.bindingGeneration === workspace.bindingGeneration &&
            held.assignmentGeneration === workspace.assignmentGeneration)) return;
      if (typeof GM_info === "undefined" || GM_info.injectInto !== "content")
        throw new Error("Verified isolated Violentmonkey content injection is required.");
      const health = await transport.health() as { schemaVersion?: number };
      if (health.schemaVersion !== 1)
        throw new Error("Gateway protocol/schema incompatible.");
      if (closing || manualConnectionEpoch !== epoch)
        throw Object.assign(new Error('Connection request was superseded.'),{code:'CONNECTION_CANCELLED'});
      await controller.attach(workspace);
    });
    connectionQueue = action.catch(() => undefined);
    return action;
  };
  /** Persistent, single-flight reconnect for transport-only outages. An
   * authoritative recovery hold always wins; effects are never replayed. */
  function scheduleReconnect(expedite=false): void {
    if(closing || !reconnectWorkspace || reconnectTimer) return;
    const capturedWorkspace=reconnectWorkspace,epoch=manualConnectionEpoch;
    const delay=Math.max(transport.connectivityRetryDelayMs(),expedite?250:Math.min(60000,1000*2**Math.min(reconnectAttempt++,6)));
    reconnectTimer=setTimeout(async()=>{
      reconnectTimer=undefined;
      if(closing || epoch!==manualConnectionEpoch ||
         reconnectWorkspace!==capturedWorkspace) return;
      try {
        const status=await transport.request('GET',
          '/api/v1/admin/workspaces/'+encodeURIComponent(capturedWorkspace)+'/recovery') as
          {action?:unknown};
        if(status.action==='WAIT_FOR_TERMINAL' || status.action==='RECONCILE'){
          reconnectWorkspace=undefined;
          manager?.setStatus({connection:'blocked',workspace:capturedWorkspace,
            reason:'A previous effect requires review. Open Recovery; no action will be replayed.'});
          return;
        }
        if(status.action!=='RECONNECT'){
          scheduleReconnect();return;
        }
        const w=await transport.request('GET',
          '/api/v1/admin/workspaces/'+encodeURIComponent(capturedWorkspace)) as Record<string,unknown>;
        if(w.id!==capturedWorkspace)throw new Error('Workspace changed while reconnecting.');
        if(await store.get<boolean>('perch:autoconnect-stop:'+capturedWorkspace)){
          reconnectWorkspace=undefined;return;
        }
        await connect(w,true,epoch);
      }catch(error){
        if(closing || epoch!==manualConnectionEpoch ||
           reconnectWorkspace!==capturedWorkspace)return;
        const code=error && typeof error==='object'&&'code'in error
          ?String((error as {code:unknown}).code):'';
        if(error instanceof TransportError && error.connectivityRetryable===false){
          reconnectWorkspace=undefined;
          manager?.setStatus({connection:'blocked',workspace:capturedWorkspace,
            reason:'Gateway storage or configuration needs repair. Automatic connection retries stopped; inspect readiness and diagnostics.'});
          return;
        }
        if(code==='EFFECT_UNKNOWN'){
          reconnectWorkspace=undefined;
          manager?.setStatus({connection:'blocked',workspace:capturedWorkspace,
            reason:'The previous operation is uncertain. Open Recovery to inspect it.'});
          return;
        }
        // TAB_BUSY and network interruptions are retryable *connection*
        // states. A new source/provider operation is never dispatched here.
      }
      scheduleReconnect();
    },delay);
    (reconnectTimer as unknown as {unref?:()=>void}).unref?.();
  }
  window.addEventListener('online',()=>{
    if(reconnectWorkspace){clearReconnect();scheduleReconnect(true);}
    else if(bootstrapTimer){clearTimeout(bootstrapTimer);bootstrapTimer=undefined;void resumeBoundEditor();}
  });
  window.addEventListener('visibilitychange',()=>{
    if(document.hidden)return;
    if(reconnectWorkspace){clearReconnect();scheduleReconnect(true);}
    else if(bootstrapTimer){clearTimeout(bootstrapTimer);bootstrapTimer=undefined;void resumeBoundEditor();}
  });
  const client: ManagerClient = {
    request: (method, path, body, options) => transport.request(method, path, body, options),
    bindingProof: async (workspace, binding) => transport.tab('/api/v1/tab/rebind-proof',{
      workspaceId:workspace.id,expectedRevision:workspace.revision,binding,tabInstanceId:controller.tabInstanceId,
      adapterVersion:'2',
    }),
    health: (origin) => transport.health(origin),
    diagnostics: () => ({
      ...transport.diagnostics(),
      browser: {...controller.diagnostics(),
        bootstrapPhase,bootstrapCode,bootstrapWorkspace,bootstrapConnectivityRetryable,
        reconnectPending:!!reconnectTimer, reconnectAttempt},
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
      manualConnectionEpoch++;
      await controller.pause();
      await transport.recover(origin, secret);
    },
    configuration: () => transport.configuration(),
    transitionReceipts: {
      async list() {
        const prefix = await transitionPrefix();
        const keys = await transitionKeys(prefix);
        return await Promise.all(keys.map(async key => {
          const receipt = await store.get<WorkspaceTransitionReceipt>(key);
          if (!receipt || key !== prefix + receipt.key || !receiptId.test(receipt.key) ||
              !/^[A-Za-z0-9_-]{1,128}$/.test(receipt.workspaceId) || !transitionActions.has(receipt.action))
            throw new Error("A retained Workspace transition record could not be verified.");
          return receipt;
        }));
      },
      async retain(receipt) {
        const prefix = await transitionPrefix();
        if ((await transitionKeys(prefix)).length >= 100)
          throw new Error("Inspect retained Workspace transitions before submitting another.");
        const key = prefix + receipt.key;
        await store.set(key, receipt);
        const verified = await store.get<WorkspaceTransitionReceipt>(key);
        if (verified?.key !== receipt.key || verified.workspaceId !== receipt.workspaceId || verified.action !== receipt.action)
          throw new Error("The Workspace transition locator could not be read back.");
      },
      async retire(key) {
        if (!receiptId.test(key)) throw new Error("Invalid transition receipt ID.");
        await store.delete((await transitionPrefix()) + key);
      },
    },
    currentIdentity: async () => ({
      ...(await adapter.identity()),
      browserInstallationId: await transport.installationId(),
    }),
    attach: async (workspace) => {
      manualConnectionEpoch++;
      reconnectWorkspace=undefined;clearReconnect();reconnectAttempt=0;
      if(bootstrapTimer)clearTimeout(bootstrapTimer);
      bootstrapTimer=undefined;
      await connect(workspace, false, manualConnectionEpoch);
      if(controller.diagnostics().connection!=='connected')
        throw new Error('The editor did not receive a verified lease. Check the connection status.');
      if (typeof workspace.id === "string") {
        await store.delete("perch:autoconnect-stop:" + workspace.id);
        try {
          const identity=await adapter.identity();
          void store.set('perch:last-connected-workspace',{
            generatorId:identity.generatorId,draftId:identity.draftId,workspaceId:workspace.id,
          }).catch(()=>undefined);
        } catch { /* Attached lease remains canonical; cache is optional. */ }
      }
    },
    pauseLocal: async () => {
      // Stop fences queued health checks and late native claim responses.
      manualConnectionEpoch++;
      if(bootstrapTimer)clearTimeout(bootstrapTimer);
      bootstrapTimer=undefined;
      bootstrapRetryAttempt=0;
      const id = controller.diagnostics().workspaceId;
      // Pause synchronously aborts the local controller before the first
      // asynchronous store write or gateway lease release can stall.
      reconnectWorkspace=undefined;clearReconnect();reconnectAttempt=0;
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
      manualConnectionEpoch++;
      if(bootstrapTimer)clearTimeout(bootstrapTimer);
      bootstrapTimer=undefined;
      await controller.pause();
      await transport.disconnect();
    },
    sourceBackup: () => controller.sourceBackup(),
    previewSourceRestore: (archive, mode) => controller.previewSourceRestore(archive, mode),
    listCheckpoints: scopeId => controller.listCheckpoints(scopeId),
    exportCheckpoint: (scopeId, checkpointId) => controller.exportCheckpoint(scopeId, checkpointId),
    setCheckpointPinned: (scopeId, checkpointId, pinned) => controller.setCheckpointPinned(scopeId, checkpointId, pinned),
    stagePrivateFile: (path, bytes) => controller.stagePrivateFile(path, bytes),
    listPrivateFiles: () => controller.listPrivateFiles(),
    previewPrivateFileImport: id => controller.previewPrivateFileImport(id),
    importPrivateFile: (id, revision) => controller.importPrivateFile(id, revision),
    reconcileOperation: (operation) => controller.reconcileOperation(operation),
    localRecovery: workspaceId => controller.localRecovery(workspaceId),
    localRecoveryScopes: () => controller.localRecoveryScopes(),
    inspectLocalRecovery: scopeId => controller.inspectLocalRecovery(scopeId),
    exportLocalRecovery: scopeId => controller.exportLocalRecovery(scopeId),
    resolveRetainedLocalHold: (scopeId, recordId, expectedInspection, evidence) =>
      controller.resolveRetainedLocalHold(scopeId, recordId, expectedInspection, evidence),
    exportWorkspaceEvidence: workspaceId => exportWorkspaceEvidence(store,workspaceId),
    resolveLocalHold: (workspaceId,journalId,expectedRevision,evidence) =>
      controller.resolveLocalHold(workspaceId,journalId,expectedRevision,evidence),
    restoreSourceBackup: (backup, intent) => controller.restoreSourceBackup(backup, intent),
    importSettings: async (settings) => {
      manualConnectionEpoch++;
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
    if (initializationError || !transport.configuration().paired || closing ||
        bootstrapRunning || controller.diagnostics().leasePresent)return;
    if(transport.connectivityRetryDelayMs()>0){retryNativeBootstrap();return;}
    bootstrapRunning=true;
    const epoch = manualConnectionEpoch;
    bootstrapPhase='NATIVE_EDITOR';bootstrapCode=null;bootstrapWorkspace=null;bootstrapConnectivityRetryable=null;
    let matchedWorkspaceId: string | undefined;
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
        if (!closing && manualConnectionEpoch === epoch){
          bootstrapCode='NATIVE_EDITOR_NOT_READY';
          manager?.setStatus({connection:'offline',
            reason:'Editor not detected yet. Open the generator in Edit mode; connection detection will retry.'});
          retryNativeBootstrap();
        }
        return;
      }
      bootstrapPhase='WORKSPACE_LOOKUP';
      // Offline display hint only. Never claim a lease from cached identity.
      try {
        const previous=await store.get<{generatorId:string;draftId:string;workspaceId:string}>('perch:last-connected-workspace');
        if(previous?.generatorId===identity.generatorId && previous.draftId===identity.draftId &&
           typeof previous.workspaceId==='string' && /^[A-Za-z0-9_-]{1,128}$/.test(previous.workspaceId))
          bootstrapWorkspace=previous.workspaceId;
      } catch { /* No cached identity is required for remote verification. */ }
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
        bootstrapCode='NO_UNIQUE_BINDING';
        manager?.setStatus({connection:'offline',
          reason:'This editor has no unique matching Workspace. Open Workspaces to link or reconnect it.'});
        return;
      }
      matchedWorkspaceId = typeof candidate.id === 'string' ? candidate.id : undefined;
      bootstrapWorkspace=matchedWorkspaceId??null;
      if (await store.get<boolean>("perch:autoconnect-stop:" + candidate.id)) {
        bootstrapCode='OPERATOR_STOP';
        manager?.setStatus({connection:'paused',workspace:matchedWorkspaceId,
          reason:'This Workspace was stopped in the browser. Select Connect this editor to resume.'});
        return;
      }
      bootstrapPhase='GATEWAY_CLAIM';
      await connect(candidate, true, epoch);
      bootstrapPhase='CONNECTED';bootstrapCode=null;bootstrapRetryAttempt=0;
      if(matchedWorkspaceId)void store.set('perch:last-connected-workspace',{
        generatorId:identity.generatorId,draftId:identity.draftId,workspaceId:matchedWorkspaceId,
      }).catch(()=>undefined);
    } catch (error) {
      if (closing || manualConnectionEpoch !== epoch) return;
      const code = error && typeof error === "object" && "code" in error &&
        typeof error.code === "string" ? error.code : "RECONNECT_FAILED";
      bootstrapCode=code;
      bootstrapWorkspace=matchedWorkspaceId??bootstrapWorkspace;
      transport.recordBootstrapFailure(bootstrapPhase,code);
      const connectivityRetryable=error instanceof TransportError ? error.connectivityRetryable : undefined;
      bootstrapConnectivityRetryable=connectivityRetryable??null;
      const temporary=isRetryableGatewayFailure(code,connectivityRetryable);
      if(temporary)retryNativeBootstrap();
      else if(connectivityRetryable===false && bootstrapTimer){clearTimeout(bootstrapTimer);bootstrapTimer=undefined;}
      manager?.setStatus({
        connection: connectivityRetryable===false || ["EFFECT_UNKNOWN","TAB_BUSY"].includes(code) ? "blocked" : "offline",
        workspace: bootstrapWorkspace??undefined,
        reason: connectivityRetryable===false
          ? 'Gateway storage or configuration needs repair. Automatic connection retries stopped; inspect readiness and diagnostics.'
          : temporary ? `Gateway unavailable (${code}). Connection will retry automatically; no source or provider operation will be repeated.`
          : code === "EFFECT_UNKNOWN"
          ? "An unresolved Gateway effect prevents a new lease. Open Recovery for the exact held operation. Never repeat the unknown effect or re-pair to clear it."
          : code === "TAB_BUSY"
            ? "A lease or claim is still active. Open Recovery to inspect its expiry and owner-safe next action; do not force takeover."
            : `Automatic reconnect did not complete (${code}). Open Recovery and inspect Gateway and local state.`,
      });
    } finally {
      bootstrapRunning=false;
    }
  }
  // Native edit mode is checked inside the adapter; a new page/tab never
  // takes over a current lease or silently changes an existing Binding.
  void resumeBoundEditor();
  window.addEventListener("pagehide", () => {
    closing = true;
    if(bootstrapTimer)clearTimeout(bootstrapTimer);
    bootstrapTimer=undefined;
    reconnectWorkspace=undefined;clearReconnect();
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
