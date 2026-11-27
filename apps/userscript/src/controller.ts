import { browserEnvelopeV2, type SegmentRequest } from '../../../packages/contracts/src/operations-v2.js';
import { parseTarget } from '../../../packages/contracts/src/target.js';
import { executeDevelopment, type DevelopmentContext } from './development-v2.js';
import type { NotificationChannel } from "./notifications.js";
import { isRetryableGatewayFailure } from "./connection-failures.js";
import { uploadImageResult } from "./image-transfer.js";
import {
  errorCodes,
  toolErrorSchema,
  validateEnvelope,
  validateToolCall,
  permissionsForTool,
  toolByName,
  type Envelope,
} from "../../../packages/contracts/src/index.js";
import { NativeAdapter } from "./adapter.js";
import { VirtualFileSystem } from "./vfs.js";
import { SourceTools } from "./source-tools.js";
import { NativeLifecycle, SavedSourceReader, lifecycleApprovalDigest, type LifecycleApproval } from "./lifecycle.js";
import { GatewayTransport, TransportError } from "./transport.js";
import { ArtifactStore } from "./artifacts.js";
import {
  BrowserError,
  base64ToBytes,
  canonicalPath,
  digest,
  equalIdentity,
  type KeyValueStore,
  type NativeIdentity,
} from "./native-types.js";

interface Lease {
  contractVersion?: 2;
  connectorId?: string | null;
  assignmentGeneration?: number;
  bindingGeneration?: number;
  installationId?: string;
  generatorId?: string;
  draftId?: string;
  workspaceId: string;
  epoch: number;
  bindingRevision: number;
  tabInstanceId: string;
  leaseCredential: string;
  expiresAt: number;
  permissions: string[];
  notifications?: { version: 1 };
}
interface LocalOperation {
  operationId: string;
  digest: string;
  epoch: number;
  tool: string;
  status: string;
  createdAt: number;
  result?: Record<string, unknown>;
  resultExpiresAt?: number;
  resolvedByOperator?: boolean;
}
export interface ControllerStatus {
  connection: "unpaired" | "connecting" | "connected" | "degraded" | "paused" | "offline" | "blocked";
  workspace?: string;
  dirty?: boolean;
  revision?: string;
  reason?: string;
}
export interface RuntimeContext {
  envelope: Envelope;
  vfs: VirtualFileSystem;
  adapter: NativeAdapter;
  signal: AbortSignal;
  call(name: string, args: Record<string, unknown>): Promise<unknown>;
  authorize(name: string, args: Record<string, unknown>): Promise<void>;
  media(
    route: "start" | "chunk",
    offset?: number,
    ackSha256?: string,
  ): Promise<unknown>;
}
export interface AdditionalTools {
  dispose?(): void;
  callDevelopment?(context: DevelopmentContext): Promise<unknown>;
  /** Read-only, no network or source effects; scoped to the bound Workspace. */
  capabilityReport?(context: RuntimeContext): Record<string, unknown>;
  preflightPreview?(context: RuntimeContext): Promise<void>;
  supports(name: string): boolean;
  call(
    name: string,
    args: Record<string, unknown>,
    context: RuntimeContext,
  ): Promise<unknown>;
}
export class BrowserController {
  readonly tabInstanceId = crypto.randomUUID();
  readonly artifacts: ArtifactStore;
  private lease?: Lease;
  private identity?: NativeIdentity;
  private vfs?: VirtualFileSystem;
  private source?: SourceTools;
  private heartbeat?: ReturnType<typeof setInterval>;
  private pollAbort?: AbortController;
  private push?: NotificationChannel;
  private renewalInFlight = false;
  private consecutivePollFailures = 0;
  private lastPollSuccessAt?: number;
  private lastFailureCode?: string;
  private lastFailureConnectivityRetryable?: boolean;
  private currentStatus: ControllerStatus = { connection: "offline" };
  private stopped = true;
  /** Monotonic attachment generation. A late claim must never undo Pause. */
  private connectionGeneration = 0;
  private lastAttachStage: string | null = null;
  private lastAttachCode: string | null = null;
  private executing = false;
  /** Browser-local iframe geometry uncertainty; never confused with provider effects. */
  private viewportUncertain = false;
  private localRecoveryWarning: string | null = null;
  private localPendingHolds: number | null = null;
  private sourceReadback: {state: 'not-checked'|'checking'|'verified'|'unavailable';code?:string} = {state:'not-checked'};
  private running?: Promise<void>;
  private abort?: AbortController;
  constructor(
    readonly adapter: NativeAdapter,
    readonly store: KeyValueStore,
    readonly transport: GatewayTransport,
    readonly tools?: AdditionalTools,
    readonly status: (state: ControllerStatus) => void = () => {},
    readonly lifecycle?: NativeLifecycle,
    readonly confirmNativeAction?: (message: string) => boolean,
  ) {
    this.artifacts = new ArtifactStore(store);
  }
  private updateStatus(next: ControllerStatus): void {
    this.currentStatus = next;
    this.status(next);
  }
  diagnostics() {
    return {
      connection: this.currentStatus.connection,
      workspaceId: this.currentStatus.workspace ?? null,
      reasonCode: this.lastFailureCode ?? null,
      connectivityRetryable: this.lastFailureConnectivityRetryable ?? null,
      consecutivePollFailures: this.consecutivePollFailures,
      lastPollSuccessAt: this.lastPollSuccessAt ?? null,
      leasePresent: !!this.lease,
      bindingGeneration: this.lease?.bindingGeneration ?? null,
      assignmentGeneration: this.lease?.assignmentGeneration ?? null,
      leaseRemainingMs: this.lease ? Math.max(0, this.lease.expiresAt - Date.now()) : 0,
      stopped: this.stopped,
      notifications: this.push?.diagnostics() ?? {state: "http"},
      failureStage: this.lastAttachStage,
      attachFailureCode: this.lastAttachCode,
      statusReason: this.currentStatus.reason ?? null,
      localPendingHolds: this.localPendingHolds,
      localRecoveryWarning: this.localRecoveryWarning,
      sourceReadback: {...this.sourceReadback},
    };
  }
  async attach(workspace: Record<string, unknown>): Promise<void> {
    const workspaceId = typeof workspace.id === "string" ? workspace.id : "";
    if (this.executing)
      throw Object.assign(new Error("Finish the active operation before changing the editor connection."), {code: "TAB_BUSY"});
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(workspaceId))
      throw Object.assign(new Error("Choose a valid Workspace."), {code: "INVALID_INPUT"});
    const previousStatus = this.currentStatus;
    const generation = ++this.connectionGeneration;
    let stage = "NATIVE_EDITOR";
    this.lastAttachCode = null;
    this.lastAttachStage = stage;
    this.updateStatus({connection: "connecting", workspace: workspaceId,
      reason: "Checking current native editor before acquiring its lease."});
    try {
      // Read-only preflight BEFORE releasing any existing lease: a missing
      // native editor must not silently replace the UI with `paused`.
      const probe = await this.adapter.probe();
      if (!probe.ready || !probe.identity)
        throw Object.assign(new Error("This page is not a ready Perchance editor. Open your generator's Edit view and reconnect."),
          {code:"NATIVE_EDITOR_NOT_READY"});
      const identity = probe.identity;
      const binding = workspace.binding;
      if (!binding || typeof binding !== "object" || Array.isArray(binding) ||
          !equalIdentity(binding as NativeIdentity, identity))
        throw Object.assign(new Error("This Workspace targets a different generator or draft. Use its explicit Bind action; connection cannot replace it."),
          {code:"BINDING_MISMATCH"});
      const installationId = await this.transport.installationId();
      if ((binding as {browserInstallationId?:unknown}).browserInstallationId !== installationId)
        throw Object.assign(new Error("This Workspace belongs to another browser installation. Rebind explicitly to revoke old Grants."),
          {code:"BINDING_MISMATCH"});
      const scoped = workspace.contractVersion === 2;
      let candidateVfs = scoped ? undefined : new VirtualFileSystem(this.adapter, this.store, workspaceId);
      stage = "LOCAL_JOURNAL";
      this.lastAttachStage = stage;
      // Local intent concerns source writes only. Never fail the entire agent
      // connection because one old journal requires native /src byte readback.
      // The VFS and Save path independently fence any unresolved mutation.
      this.localPendingHolds = null;
      this.localRecoveryWarning = null;
      this.sourceReadback = {state:'not-checked'};
      try { if (candidateVfs) this.localPendingHolds = (await candidateVfs.unresolved()).length; }
      catch (error) {
        this.localRecoveryWarning = error instanceof Error ? error.name : 'LOCAL_STORE_UNAVAILABLE';
      }
      if (generation !== this.connectionGeneration) return;
      // Pause is only reached after a complete native and local preflight.
      // Its intermediate status must not be mistaken for a requested Stop.
      await this.pause();
      const claimGeneration = this.connectionGeneration;
      if (claimGeneration !== generation + 1) return;
      this.updateStatus({connection:"connecting",workspace:workspaceId,
        reason:"Requesting the verified editor lease."});
      const claimBinding = {...identity,browserInstallationId:installationId};
      stage = "GATEWAY_CLAIM";
      this.lastAttachStage = stage;
      const claim = (await this.transport.tab("/api/v1/tab/claim", {
        workspaceId, binding: claimBinding, tabInstanceId: this.tabInstanceId,
        adapterVersion: scoped ? "2" : "1",
      })) as Lease;
      if (!claim || claim.workspaceId !== workspaceId ||
          claim.tabInstanceId !== this.tabInstanceId ||
          !Number.isInteger(claim.epoch) || claim.epoch < 1 ||
          !claim.leaseCredential || !Array.isArray(claim.permissions) ||
          (scoped ? claim.contractVersion !== 2 || claim.installationId !== installationId ||
            claim.generatorId !== identity.generatorId || claim.draftId !== identity.draftId ||
            claim.assignmentGeneration !== workspace.assignmentGeneration || claim.bindingGeneration !== workspace.bindingGeneration :
            claim.contractVersion !== undefined))
        throw Object.assign(new Error("Gateway lease response is invalid."),{code:"INVALID_RESPONSE"});
      // Pause/Stop may race a slow claim reply. Never revive the old tab;
      // attempt a best-effort release using only the returned lease secret.
      if (claimGeneration !== this.connectionGeneration) {
        try { await this.transport.tab("/api/v1/tab/release",{
          workspaceId:claim.workspaceId,epoch:claim.epoch,
          tabInstanceId:claim.tabInstanceId,
        },claim.leaseCredential); } catch { /* Expiration remains authoritative. */ }
        return;
      }
      this.adapter.bind(identity);
      this.identity = identity;
      this.lease = claim;
      if (scoped) {
        stage = 'BINDING_STORAGE';
        this.lastAttachStage = stage;
        try {
          candidateVfs = await VirtualFileSystem.openBound(this.adapter, this.store, {
            workspaceId, installationId, assignmentGeneration: claim.assignmentGeneration!,
            bindingGeneration: claim.bindingGeneration!, epoch: claim.epoch,
            generatorId: identity.generatorId, draftId: identity.draftId,
          }, { assertCurrent: async () => {
            if (this.lease !== claim || claimGeneration !== this.connectionGeneration || claim.expiresAt <= Date.now())
              throw new BrowserError('STALE_EPOCH', 'Binding storage writer has lost its lease.');
            await this.adapter.assertIdentity();
            if (this.lease !== claim || claimGeneration !== this.connectionGeneration || claim.expiresAt <= Date.now())
              throw new BrowserError('STALE_EPOCH', 'Binding storage writer changed during native identity verification.');
          } });
          this.localPendingHolds = (await candidateVfs.unresolved()).length;
        } catch (error) {
          if (this.lease === claim) {
            this.lease = undefined;
            try { await this.transport.tab('/api/v1/tab/release', this.ids(claim), claim.leaseCredential); }
            catch { /* The failed lease expires and cannot write. */ }
          }
          throw error;
        }
        if (this.lease !== claim || claimGeneration !== this.connectionGeneration) return;
      }
      const connectedVfs = candidateVfs!;
      this.vfs = connectedVfs;
      this.source = new SourceTools(this.vfs, this.adapter);
      this.viewportUncertain = false;
      this.stopped = false;
      this.lastFailureCode = undefined;
      this.lastFailureConnectivityRetryable = undefined;
      this.lastAttachCode = null;
      this.lastAttachStage = null;
      this.consecutivePollFailures = 0;
      this.pollAbort = new AbortController();
      if (claim.notifications?.version === 1 && typeof this.transport.notifications === "function")
        this.push = this.transport.notifications(claim);
      if (scoped) void this.renew(claim);
      this.heartbeat = setInterval(() => {void this.renew(claim);}, 60000);
      (this.heartbeat as unknown as {unref?:()=>void}).unref?.();
      this.updateStatus({connection:"connected",workspace:workspaceId,dirty:probe.dirty,
        ...(this.localPendingHolds ? {reason:`${this.localPendingHolds} local source operation(s) need review. The agent connection stays online; source writes remain fenced.`} :
          this.localRecoveryWarning ? {reason:'Local storage inspection unavailable. The agent connection stays online; writes remain fail-closed.'} : {})});
      // Probe actual complete native bytes after obtaining the lease, without
      // turning readback failure into a transport failure. Agent status must be
      // truthful even when a platform-specific source bridge is unavailable.
      this.sourceReadback = {state:'checking'};
      void connectedVfs.snapshot().then(()=>{
        if(this.lease!==claim || this.stopped)return;
        this.sourceReadback = {state:'verified'};
      }).catch(error=>{
        if(this.lease!==claim || this.stopped)return;
        const code=error && typeof error==='object' && 'code' in error
          ? String((error as {code:unknown}).code) : 'SOURCE_READBACK_UNAVAILABLE';
        this.sourceReadback = {state:'unavailable',code};
        this.updateStatus({connection:'connected',workspace:workspaceId,dirty:probe.dirty,
          reason:'Source readback is unavailable ('+code+'). The agent stays connected; source writes remain disabled.'});
      });
      // Reconcile retained local source intents against two independent native
      // snapshots before consulting gateway Activity. Old local UUIDs are not
      // gateway Operation IDs. Neither readback nor storage outages drop the lease.
      if (this.localPendingHolds) void connectedVfs.reconcileRetained()
        .then(()=>this.syncResolvedLocal(connectedVfs,workspaceId))
        .then(async()=>{
          const remaining = (await connectedVfs.unresolved()).length;
          if (this.lease !== claim || this.stopped) return;
          this.localPendingHolds = remaining;
          if (!remaining) this.updateStatus({connection:'connected',workspace:workspaceId,dirty:probe.dirty});
        }).catch(error=>{
          if (this.lease !== claim || this.stopped) return;
          this.localRecoveryWarning = error && typeof error==='object' && 'code' in error
            ? String((error as {code:unknown}).code) : 'LOCAL_READBACK_UNAVAILABLE';
        });
      this.running = this.poll().catch((error:unknown) => {
        if (this.lease !== claim || this.stopped) return;
        this.stopped = true;
        this.push?.stop();
        this.pollAbort?.abort();
        if (this.heartbeat) clearInterval(this.heartbeat);
        this.heartbeat = undefined;
        this.lastFailureCode = error instanceof TransportError ? error.code : "POLL_FAILED";
        this.lastFailureConnectivityRetryable = error instanceof TransportError ? error.connectivityRetryable : undefined;
        this.updateStatus({connection:this.lastFailureConnectivityRetryable===false?"blocked":"offline",workspace:workspaceId,
          reason:this.lastFailureConnectivityRetryable===false
            ? "Gateway storage or configuration needs repair. Automatic connection retries stopped; inspect readiness and diagnostics."
            : `Poll stopped (${this.lastFailureCode}). Read-only reconnect will check the lease and any pending effects.`});
      });
    } catch (error) {
      if (generation !== this.connectionGeneration &&
          // The internal pause increments the generation exactly once.
          generation + 1 !== this.connectionGeneration) throw error;
      const code=error && typeof error==="object" && "code" in error &&
        typeof error.code==="string" ? error.code : "CONNECTION_FAILED";
      this.lastFailureCode = code;
      this.lastFailureConnectivityRetryable = error instanceof TransportError ? error.connectivityRetryable : undefined;
      this.lastAttachCode = code;
      this.lastAttachStage = stage;
      const blocked=this.lastFailureConnectivityRetryable===false || ["BINDING_MISMATCH","EFFECT_UNKNOWN","TAB_BUSY","PAUSED","SCOPE_DENIED"].includes(code);
      const reason=`Connection failed at ${stage} (${code}). ${error instanceof Error ? error.message : "Inspect the editor and Workspace before retrying."}`;
      // A failed preflight never evicts an unrelated healthy lease.
      this.updateStatus(this.lease ? {...previousStatus,reason} :
        {connection:blocked?"blocked":"offline",workspace:workspaceId,reason});
      throw error;
    }
  }
  async pause(): Promise<void> {
    const generation = ++this.connectionGeneration;
    this.stopped = true;
    this.push?.stop();
    this.push = undefined;
    this.pollAbort?.abort();
    this.pollAbort = undefined;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    this.abort?.abort();
    const lease = this.lease;
    this.lease = undefined;
    // A transport abort never asserts cancellation of a dispatched effect.
    if (lease) {
      try {
        await this.transport.tab(
          "/api/v1/tab/release",
          this.ids(lease),
          lease.leaseCredential,
        );
      } catch {
        /* authoritative gateway expires lease conservatively */
      }
    }
    if (generation !== this.connectionGeneration) return;
    this.tools?.dispose?.();
    this.updateStatus({
      connection: this.transport.configuration().paired ? "paused" : "unpaired",
    });
  }
  private async renew(lease: Lease): Promise<void> {
    if (this.stopped || this.lease !== lease || this.renewalInFlight) return;
    this.renewalInFlight = true;
    try {
      let observation = {};
      if (lease.contractVersion === 2) {
        const current = await this.adapter.probe();
        observation = {dirty: current.ready && current.identity && this.identity &&
          equalIdentity(current.identity, this.identity) ? current.dirty ?? null : null};
      }
      const state = (await this.transport.tab(
        "/api/v1/tab/heartbeat",
        {...this.ids(lease), ...observation},
        lease.leaseCredential,
      )) as { expiresAt: number; permissions: string[]; workAvailable?: boolean };
      if (this.stopped || this.lease !== lease) return;
      if (
        !Number.isSafeInteger(state.expiresAt) ||
        state.expiresAt <= Date.now()
      )
        throw new Error("Expired lease.");
      lease.expiresAt = Math.max(lease.expiresAt, state.expiresAt);
      this.push?.reconcile(state.workAvailable === true);
      if (Array.isArray(state.permissions))
        lease.permissions = lease.permissions.filter((p) =>
          state.permissions.includes(p),
        );
    } catch (error) {
      if (this.stopped || this.lease !== lease) return;
      const code = error instanceof TransportError ? error.code : "HEARTBEAT_FAILED";
      this.lastFailureCode = code;
      this.lastFailureConnectivityRetryable = error instanceof TransportError ? error.connectivityRetryable : undefined;
      // The poll request also refreshes the same lease. A transient failed
      // heartbeat is not proof of lease revocation or loss of connection.
      const temporary = isRetryableGatewayFailure(code, this.lastFailureConnectivityRetryable);
      if (temporary && lease.expiresAt > Date.now() + 1000) {
        this.updateStatus({
          connection: "degraded", workspace: lease.workspaceId,
          reason: `Heartbeat temporarily unavailable (${code}); existing lease retained.`,
        });
        return;
      }
      this.stopped = true;
      this.push?.stop();
      this.pollAbort?.abort();
      this.abort?.abort();
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = undefined;
      this.updateStatus({
        connection: temporary ? "offline" : "blocked", workspace: lease.workspaceId,
        reason: temporary
          ? `Gateway outage (${code}); lease expired. Connection recovery will run without replaying effects.`
          : `Lease renewal rejected (${code}). Inspect pending effects before reconnecting.`,
      });
    } finally {
      this.renewalInFlight = false;
    }
  }
  private ids(lease: Lease) {
    return {
      workspaceId: lease.workspaceId,
      epoch: lease.epoch,
      tabInstanceId: lease.tabInstanceId,
    };
  }
  private async backupVfs(): Promise<VirtualFileSystem> {
    if (this.vfs && (!this.vfs.scope ||
        (this.lease?.contractVersion === 2 && this.lease.epoch === this.vfs.scope.epoch))) return this.vfs;
    const identity = await this.adapter.identity();
    const scope =
      "backup-" + (await digest(JSON.stringify(identity))).slice(0, 32);
    return new VirtualFileSystem(this.adapter, this.store, scope);
  }
  async sourceBackup(): Promise<unknown> {
    return (await this.backupVfs()).exportBackup();
  }
  async restoreSourceBackup(value: unknown): Promise<void> {
    if (this.executing)
      throw new Error(
        "Pause and settle the active operation before restoring source.",
      );
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid source backup.");
    const backup = value as {
      version?: unknown;
      identity?: NativeIdentity;
      files?: Record<string, unknown>;
      sha256?: unknown;
    };
    if (
      backup.version !== 1 ||
      !backup.identity ||
      !backup.files ||
      typeof backup.files !== "object" ||
      Array.isArray(backup.files) ||
      Object.keys(backup.files).length > 1000 ||
      !equalIdentity(backup.identity, await this.adapter.identity()) ||
      (await digest(JSON.stringify(backup.files))) !== backup.sha256
    )
      throw new Error(
        "Backup identity, version or digest does not match this native draft.",
      );
    const files: Record<string, Uint8Array> = Object.create(null) as Record<
      string,
      Uint8Array
    >;
    let total = 0;
    for (const [path, data] of Object.entries(backup.files)) {
      canonicalPath(path);
      if (typeof data !== "string")
        throw new Error("Invalid backup file encoding.");
      const bytes = base64ToBytes(data);
      total += bytes.length;
      if (total > 64 * 1024 * 1024)
        throw new Error("Source backup exceeds 64 MiB.");
      files[path] = bytes;
    }
    if (!files["main.pjs"] || !files["index.html"])
      throw new Error("Backup must contain both native panels.");
    const vfs = await this.backupVfs(),
      before = await vfs.snapshot();
    const paths = new Set([
      ...Object.keys(before.files),
      ...Object.keys(files),
    ]);
    const result = await vfs.writeBatch(
      [...paths]
        .filter((p) => !p.startsWith("imports/"))
        .map((path) => ({ path, bytes: files[path] ?? null })),
      before.revision,
    );
    if (result.status !== "SUCCEEDED")
      throw new Error(
        "Source restore requires reconciliation; no Save was performed.",
      );
  }
  async reconcileOperation(
    operation: Record<string, unknown> & { operatorEvidence: string },
  ): Promise<void> {
    if (this.executing)
      throw new Error(
        "Stop and settle the active operation before recording a resolution.",
      );
    const workspaceId = String(operation.workspaceId ?? ""),
      operationId = String(operation.operationId ?? "");
    if (
      !/^[A-Za-z0-9_-]{1,128}$/.test(workspaceId) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(operationId) ||
      !operation.operatorEvidence.trim()
    )
      throw new Error("Exact operation and inspection evidence required.");
    await this.pause();
    let cursor: string | undefined;
    let workspace: Record<string, unknown> | undefined;
    do {
      const page = (await this.transport.request(
        "GET",
        "/api/v1/admin/workspaces" +
          (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""),
      )) as { items: Record<string, unknown>[]; cursor?: string | null };
      workspace = page.items.find((w) => w.id === workspaceId);
      cursor = page.cursor ?? undefined;
      if (workspace) break;
    } while (cursor);
    const assigned = (workspace?.binding ||
      (workspace?.recoveryBinding as {binding?:unknown}|undefined)?.binding) as NativeIdentity|undefined;
    const nativeIdentity=await this.adapter.identity();
    const sameIdentity=assigned && equalIdentity(assigned,nativeIdentity);
    // Rename may navigate from the old Slug while retaining the exact
    // persisted Generator ID/Draft. This is a human resolution of uncertainty,
    // not an automatic proof of success or a rebind to the new Slug.
    const renamedSameGenerator=operation.tool==='rename_generator' && assigned &&
      assigned.generatorId===nativeIdentity.generatorId &&
      assigned.draftId===nativeIdentity.draftId &&
      (assigned.publicId===undefined || assigned.publicId===nativeIdentity.publicId);
    if(!workspace||!assigned||(!sameIdentity&&!renamedSameGenerator))
      throw new Error('Open the exact assigned Generator and Draft (or the same Generator ID after URL rename) before resolving.');
    const vfs = await this.recoveryVfs(workspace, operation.epoch, operation.bindingRevision, assigned),
      snapshot = await vfs.snapshot();
    const observedDigest = snapshot.revision.split(":")[1];
    const resolution = await this.transport.request(
      "POST",
      `/api/v1/admin/workspaces/${workspaceId}/resolve`,
      {
        expectedRevision: workspace.revision,
        operationId,
        epoch: operation.epoch,
        bindingRevision: operation.bindingRevision,
        observedRevision: snapshot.revision,
        observedDigest,
        evidence: operation.operatorEvidence.slice(0, 512),
        acknowledgeUncertainty: true,
      },
    );
    // Local source acknowledgement is a separate durable record; the original effect status is retained.
    // Only the journal owned by this exact external operation may be
    // acknowledged. Other unknown writes/imports are independent holds.
    for (const journal of (await vfs.unresolved()).filter(j=>j.gatewayOperationId===operationId))
      await vfs.acknowledgeReconciliation(journal.id, snapshot.revision);
    const key = this.operationPrefix(workspaceId, vfs) + operationId,
      local = await this.store.get<LocalOperation>(key);
    if (local) {
      local.resolvedByOperator = true;
      await this.store.set(key, local);
    }
    void resolution;
    this.updateStatus({
      connection: "paused",
      workspace: workspaceId,
      reason:
        "Operator resolution recorded. Reconnect explicitly; original effect remains uncertain.",
    });
  }
  /** Read-only local journal status; does not require a live gateway lease. */
  async localRecovery(workspaceId:string):Promise<{revision:string;sourceError?:string;holds:Array<{
    id:string;kind:string;state:string;createdAt:number;paths:string[];baseRevision:string;
  }>}> {
    if(!/^[A-Za-z0-9_-]{1,128}$/.test(workspaceId))throw new Error('Invalid Workspace ID.');
    const w=await this.getRecoveryWorkspace(workspaceId);
    await this.assertRecoveryIdentity(w);
    const vfs = await this.recoveryVfs(w);
    // Read-only native rebase is attempted automatically; this view is only
    // for genuinely recent or unobservable effects.
    await vfs.reconcileRetained().catch(()=>[]);
    const holds = await vfs.unresolved();
    // The exact pending records are inspectable even when a foreign page-realm
    // /src buffer cannot be cloned. Resolution still requires full readback.
    let revision = '';
    let sourceError: string | undefined;
    try { revision = (await vfs.snapshot()).revision; }
    catch(error) { sourceError = error && typeof error==='object' && 'code' in error
      ? String((error as {code:unknown}).code) : 'SOURCE_READBACK_UNAVAILABLE'; }
    return {revision,sourceError,holds:holds.map(j=>({
      id:j.id,kind:j.kind??'SOURCE',state:j.state,createdAt:j.createdAt,
      paths:j.paths.slice(0,30),baseRevision:j.baseRevision,
    }))};
  }
  async resolveLocalHold(workspaceId:string,journalId:string,
    expectedRevision:string,evidence:string):Promise<void> {
    if(!/^[A-Za-z0-9_-]{1,128}$/.test(journalId)||
       !evidence.trim()||evidence.length>512)throw new Error('Exact hold and inspection evidence required.');
    if(this.executing)throw new Error('Wait for the active operation before local reconciliation.');
    const w=await this.getRecoveryWorkspace(workspaceId);
    await this.assertRecoveryIdentity(w);
    const vfs = await this.recoveryVfs(w);
    const snapshot=await vfs.snapshot();
    if(snapshot.revision!==expectedRevision)throw new Error('Native source changed: inspect again before resolution.');
    if(!(await vfs.unresolved()).some(j=>j.id===journalId))
      throw new Error('This local hold was already resolved or no longer exists.');
    // Evidence is a mandatory operator acknowledgement; never stored with
    // private source or repeated to the gateway for this browser-local hold.
    await vfs.acknowledgeReconciliation(journalId,expectedRevision,evidence);
  }
  private async recoveryVfs(workspace: Record<string, unknown>, exactEpoch?: unknown,
      exactBindingGeneration?: unknown, identity?: NativeIdentity): Promise<VirtualFileSystem> {
    const workspaceId = String(workspace.id);
    if (workspace.contractVersion !== 2)
      return new VirtualFileSystem(this.adapter, this.store, workspaceId);
    const tuple = (identity ?? workspace.binding) as (NativeIdentity & {browserInstallationId?: string}) | undefined;
    if (!tuple?.browserInstallationId || typeof workspace.assignmentGeneration !== 'number')
      throw new BrowserError('BINDING_MISMATCH', 'Recovery requires the exact Binding installation.');
    return VirtualFileSystem.openBound(this.adapter, this.store, {
      workspaceId, installationId: tuple.browserInstallationId,
      generatorId: tuple.generatorId, draftId: tuple.draftId,
      assignmentGeneration: workspace.assignmentGeneration,
      bindingGeneration: Number(exactBindingGeneration ?? workspace.bindingGeneration),
      epoch: Number(exactEpoch ?? workspace.epoch),
    }, {readOnly: true, assertCurrent: () => undefined});
  }
  private operationPrefix(workspaceId: string, vfs = this.vfs): string {
    return vfs?.workspaceId === workspaceId && vfs.scope
      ? vfs.scope.epochPrefix + ':operation:'
      : `perch:operation:${workspaceId}:`;
  }
  private async getRecoveryWorkspace(workspaceId:string):Promise<Record<string,unknown>> {
    if(!/^[A-Za-z0-9_-]{1,128}$/.test(workspaceId))throw new Error('Invalid Workspace ID.');
    const w=await this.transport.request('GET','/api/v1/admin/workspaces/'+workspaceId);
    if(!w||typeof w!=='object'||Array.isArray(w))throw new Error('Workspace unavailable.');
    return w as Record<string,unknown>;
  }
  private async assertRecoveryIdentity(workspace:Record<string,unknown>):Promise<void> {
    const w=workspace.binding || (workspace.recoveryBinding as {binding?:unknown}|undefined)?.binding;
    if(!w || !equalIdentity(w as NativeIdentity,await this.adapter.identity()))
      throw new Error('Open the exact assigned Generator and Draft before reconciling local writes.');
  }
  async localArtifacts() {
    return this.artifacts.list();
  }
  private async poll(): Promise<void> {
    let waitForNotification = false, observedRevision = 0;
    while (!this.stopped && this.lease) {
      const lease = this.lease, push = this.push;
      if (push) {
        // Reconnect only between HTTP requests. Never abort a poll which may
        // already have durably dispatched an operation.
        await push.connectIfDue();
        if (waitForNotification && push.healthy)
          await push.wait(observedRevision, this.pollAbort?.signal);
        if (this.stopped || this.lease !== lease || this.push !== push) return;
      }
      const beforeFetch = push?.revision ?? 0;
      let reply: { operations?: unknown[]; expiresAt?: number };
      try {
        // The Worker holds an idle poll for up to 25 seconds. A 45-second
        // browser budget allows network/proxy latency without a false offline
        // transition. Abort on explicit Pause or document navigation.
        reply = (await this.transport.tab(
          "/api/v1/tab/poll", { ...this.ids(lease),
            ...(push?.healthy || push?.immediateFallback ? { waitMs: 0 } : {}) }, lease.leaseCredential,
          { timeoutMs: 45000, signal: this.pollAbort?.signal },
        )) as { operations?: unknown[]; expiresAt?: number };
      } catch (error) {
        if (this.stopped || this.lease !== lease) return;
        const code = error instanceof TransportError ? error.code : "POLL_FAILED";
        waitForNotification = false;
        this.lastFailureCode = code;
        this.lastFailureConnectivityRetryable = error instanceof TransportError ? error.connectivityRetryable : undefined;
        this.consecutivePollFailures++;
        // The gateway serializes dispatched Operations. Re-polling the
        // current lease never issues a new Workspace claim or duplicates an
        // operation ACK. Only transient network failures are retried here.
        if (
          !isRetryableGatewayFailure(code, this.lastFailureConnectivityRetryable) ||
          Date.now() + 1500 >= lease.expiresAt
        ) throw error;
        this.updateStatus({
          connection: "degraded", workspace: lease.workspaceId,
          reason: `Temporary connection interruption (${code}); resuming the existing lease.`,
        });
        // A short-lived VPN switch, throttled background tab or Cloudflare
        // timeout must not strand the agent after a fixed three-strike count.
        // Retry *only the read-only poll* and never re-ACK/replay an effect.
        const quotaDelay=error instanceof TransportError && error.connectivityRetryAfterSeconds===300 ? 300000 : 0;
        const backoff=Math.max(quotaDelay,Math.min(10000,250*2**Math.min(this.consecutivePollFailures-1,6)));
        await new Promise((resolve) => setTimeout(resolve,Math.min(backoff,
          Math.max(0,lease.expiresAt-Date.now()-1000))));
        continue;
      }
      this.consecutivePollFailures = 0;
      this.lastPollSuccessAt = Date.now();
      this.lastFailureCode = undefined;
      this.lastFailureConnectivityRetryable = undefined;
      if (this.currentStatus.connection === "degraded" && !this.viewportUncertain)
        this.updateStatus({ connection: "connected", workspace: lease.workspaceId });
      if (this.stopped || this.lease !== lease) return;
      if (
        !reply ||
        !Array.isArray(reply.operations) ||
        reply.operations.length > 8
      )
        throw new Error("Invalid poll response.");
      if (typeof reply.expiresAt === "number" && Number.isSafeInteger(reply.expiresAt))
        lease.expiresAt = Math.max(lease.expiresAt, reply.expiresAt);
      push?.fetched();
      for (const raw of reply.operations) {
        if (this.stopped) break;
        await this.execute(raw, lease);
      }
      waitForNotification = !reply.operations.length && push?.healthy === true;
      observedRevision = beforeFetch;
      // A healthy notification channel sleeps without periodic work-fetches.
      // The existing heartbeat wakes this loop only when authoritative work
      // is pending, recovering a dropped advisory signal within its cadence.
      if (!reply.operations.length && !waitForNotification)
        await new Promise((resolve) =>
          setTimeout(resolve, 500 + Math.random() * 250),
        );
    }
  }
  private async execute(raw: unknown, lease: Lease): Promise<void> {
    if (this.executing)
      throw Object.assign(new Error("Concurrent execution denied."), {
        code: "TAB_BUSY",
      });
    this.executing = true;
    try {
      await this.executeOperation(raw, lease);
    } finally {
      this.executing = false;
    }
  }
  private async executeScopedOperation(raw: unknown, lease: Lease): Promise<void> {
    const parsed = browserEnvelopeV2.safeParse(raw);
    if (!parsed.success) throw new BrowserError('INCOMPATIBLE_VERSION', 'A scoped v2 envelope is required.');
    const envelope = parsed.data, target = parseTarget(envelope.target), vfs = this.vfs;
    if (!vfs?.scope || envelope.workspaceId !== lease.workspaceId || target.workspaceId !== lease.workspaceId ||
        envelope.tabInstanceId !== this.tabInstanceId || envelope.connectorId !== lease.connectorId || envelope.epoch !== lease.epoch ||
        envelope.bindingRevision !== lease.bindingRevision || envelope.bindingGeneration !== lease.bindingGeneration ||
        target.bindingGeneration !== lease.bindingGeneration || envelope.assignmentGeneration !== lease.assignmentGeneration ||
        target.assignmentGeneration !== lease.assignmentGeneration || !envelope.permissions.every(p=>lease.permissions.includes(p)))
      throw new BrowserError('STALE_EPOCH','Operation does not match this exact scoped lease.');
    this.abort = new AbortController();
    const signal = this.abort.signal;
    const assertCurrent = async () => {
      if (signal.aborted || this.stopped || this.lease !== lease)
        throw new BrowserError('CANCELLED','Operation is cancelled or its lease is no longer active.');
      const now = Date.now();
      if (now >= lease.expiresAt || now >= envelope.deadlineMs || envelope.deadlineMs - now > 3_600_000)
        throw new BrowserError('TIMEOUT','Exact scoped operation deadline expired.');
      await vfs.scope!.assertCurrent();
    };
    await assertCurrent();
    const operationId = envelope.operationId;
    const key = this.operationPrefix(envelope.workspaceId) + operationId;
    const seal = await digest(JSON.stringify(envelope));
    const reply = (phase: string, result?: Record<string,unknown>) => this.transport.tab(
      '/api/v1/tab/reply', {...this.ids(lease),operationId,phase,...(result ? {result} : {})},lease.leaseCredential);
    const existing = await this.store.get<LocalOperation>(key);
    if (existing) {
      if (existing.digest !== seal) throw new BrowserError('NATIVE_CONFLICT','Operation envelope changed on replay.');
      const retained = existing.result;
      const result = retained && (existing.resultExpiresAt ?? 0) > Date.now() ? retained : {
        operationId,status:'UNKNOWN',effectState:'POSSIBLE',
        error:{code:'EFFECT_UNKNOWN',message:'Scoped operation has retained execution evidence.',
          retryable:false,recovery:'Use the original operationKey to reconcile; no execution was repeated.'},
      };
      await reply(String(result.status),result);
      return;
    }
    const intent: LocalOperation & {segments: SegmentRequest[]; steps: Record<string,unknown>[]} = {
      operationId, digest:seal, epoch:envelope.epoch, tool:envelope.tool,status:'RUNNING',createdAt:Date.now(),segments:[],steps:[],
    };
    await this.store.set(key,intent);
    await reply('RUNNING');
    let result: Record<string,unknown>;
    const context: DevelopmentContext = {
      envelope,vfs,signal,assertCurrent,
      permit: async (kind, inputDigest) => {
        await assertCurrent();
        const segment = {sequence:intent.segments.length,kind,digest:inputDigest};
        intent.segments.push(segment);
        await this.store.set(key,intent);
        const permit = await this.transport.tab('/api/v1/tab/segment', {
          ...this.ids(lease),operationId,segment,
        },lease.leaseCredential,{signal}) as {operationId?:unknown;sequence?:unknown;digest?:unknown;expiresAt?:number};
        if (permit.operationId!==operationId || permit.sequence!==segment.sequence ||
            permit.digest!==inputDigest || !Number.isSafeInteger(permit.expiresAt) || permit.expiresAt!<=Date.now())
          throw new BrowserError('REVOKED','Segment receipt is unavailable or stale.');
        await assertCurrent();
      },
      recordStep: async step => {
        intent.steps[step.index]=step;
        await this.store.set(key,intent);
      },
      additional: async () => {
        throw new BrowserError('UNSUPPORTED_INTERFACE','The required v2 preview or native interface is unavailable.');
      },
    };
    try {
      const data = await (this.tools?.callDevelopment ? this.tools.callDevelopment(context) : executeDevelopment(context));
      const reported = data as {status?:string};
      const status = reported?.status === 'PARTIAL' || reported?.status === 'UNKNOWN' || (reported?.status==='REJECTED' || reported?.status==='CANCELLED') ? reported.status : 'SUCCEEDED';
      const effectState = status==='PARTIAL'?'PARTIAL':status==='UNKNOWN'?'POSSIBLE':status==='REJECTED'||status==='CANCELLED'?'NONE':'VERIFIED';
      result = {operationId,status,effectState,data:new TextEncoder().encode(JSON.stringify(data)).length <= 240_000 ?
        data : {resultAvailability:'TOO_LARGE'}};
      if (status!=='SUCCEEDED') result.error = {code:status==='PARTIAL'?'PARTIAL_EFFECT':status==='UNKNOWN'?'EFFECT_UNKNOWN':status==='CANCELLED'?'CANCELLED':'PROVIDER_REJECTED',
        message:'Inspect exact operation or step evidence.',retryable:false,recovery:'Reconcile recorded effects before another mutation.'};
    } catch (error) {
      const fault = error as {code?:string;effectState?:string};
      const code = errorCodes.includes(fault.code as (typeof errorCodes)[number]) ? fault.code! : 'PROVIDER_REJECTED';
      const unknown = fault.effectState==='UNKNOWN' || code==='EFFECT_UNKNOWN';
      const status = fault.effectState==='PARTIAL'?'PARTIAL':unknown?'UNKNOWN':code==='CANCELLED'?'CANCELLED':'REJECTED';
      const detail = envelope.tool==='capture_page_image' && code==='UNSUPPORTED_INTERFACE' && error instanceof BrowserError
        ? error.message : 'Scoped operation stopped at '+code+'.';
      result = {operationId,status,effectState:status==='PARTIAL'?'PARTIAL':unknown?'POSSIBLE':'NONE',
        error:{code,message:detail,retryable:false,
          recovery:'Inspect operation status and reconcile before retrying an effect.'}};
    }
    intent.status=String(result.status);
    intent.result=result;
    intent.resultExpiresAt=Date.now()+600_000;
    await this.store.set(key,intent);
    await reply(intent.status,result);
  }
  private async executeOperation(raw: unknown, lease: Lease): Promise<void> {
    if (lease.contractVersion === 2) return this.executeScopedOperation(raw, lease);
    const envelope = validateEnvelope(raw);
    const vfs = this.vfs!;
    if (
      envelope.workspaceId !== lease.workspaceId ||
      envelope.tabInstanceId !== this.tabInstanceId ||
      envelope.epoch !== lease.epoch ||
      envelope.bindingRevision !== lease.bindingRevision ||
      Date.now() >= lease.expiresAt
    )
      throw new Error("Fenced operation. Reconnect the Workspace.");
    const identity = await this.adapter.identity();
    if (!this.identity || !equalIdentity(identity, this.identity)) {
      this.stopped = true;
      this.updateStatus({
        connection: "blocked",
        reason: "Generator or Draft changed. Rebind explicitly.",
      });
      throw new Error("Binding mismatch.");
    }
    const hash = await digest(
      JSON.stringify([
        envelope.tool,
        envelope.args,
        envelope.workspaceId,
        envelope.epoch,
        envelope.bindingRevision,
        envelope.permissions,
        envelope.expectedRevision,
      ]),
    );
    const key = this.operationPrefix(lease.workspaceId) + envelope.operationId;
    const existing = await this.store.get<LocalOperation>(key);
    if (existing) {
      if (existing.digest !== hash) throw new Error("Operation ID collision.");
      const result =
        existing.result && (existing.resultExpiresAt ?? 0) > Date.now()
          ? existing.result
          : {
              operationId: envelope.operationId,
              status: "UNKNOWN",
              effectState: "POSSIBLE",
              error: {
                code:
                  existing.status === "RUNNING"
                    ? "EFFECT_UNKNOWN"
                    : "RESULT_EXPIRED",
                message: "Operation retained; no replay.",
                retryable: false,
                recovery: "Inspect operation_status and reconcile.",
              },
            };
      await this.transport.tab(
        "/api/v1/tab/reply",
        {
          ...this.ids(lease),
          operationId: envelope.operationId,
          phase: result.status,
          result,
        },
        lease.leaseCredential,
      );
      return;
    }
    const operation: LocalOperation = {
      operationId: envelope.operationId,
      digest: hash,
      epoch: envelope.epoch,
      tool: envelope.tool,
      status: "RUNNING",
      createdAt: Date.now(),
    };
    await this.pruneOperations(lease.workspaceId);
    await this.store.set(key, operation); // Durable intent precedes ACK and any effect.
    await this.transport.tab(
      "/api/v1/tab/reply",
      {
        ...this.ids(lease),
        operationId: envelope.operationId,
        phase: "RUNNING",
      },
      lease.leaseCredential,
    );
    this.abort = new AbortController();
    const signal = this.abort.signal;
    let result: Record<string, unknown>;
    try {
      const context: RuntimeContext = {
        envelope,
        vfs,
        adapter: this.adapter,
        signal,
        call: (name, args) => this.invoke(name, args, context, lease),
        authorize: (name, args) =>
          this.authorizeChild(name, args, context, lease),
        media: async (route, offset, ackSha256) => {
          if (
            this.stopped ||
            this.lease !== lease ||
            signal.aborted ||
            !envelope.permissions.includes("MEDIA")
          )
            throw Object.assign(new Error("Media execution context expired."), {
              code: "SCOPE_DENIED",
            });
          return this.transport.tab(
            route === "start"
              ? "/api/v1/tab/music"
              : "/api/v1/tab/music-result",
            {
              ...this.ids(lease),
              operationId: envelope.operationId,
              ...(offset === undefined ? {} : { offset }),
              ...(ackSha256 ? { ackSha256 } : {}),
            },
            lease.leaseCredential,
            {
              timeoutMs: Math.min(
                600000,
                Math.max(1, envelope.deadlineMs - Date.now()),
              ),
              signal,
            },
          );
        },
      };
      let data = await this.invoke(
        envelope.tool,
        envelope.args,
        context,
        lease,
      );
      if (
        ["read_image", "generate_image", "capture_page_image"].includes(
          envelope.tool,
        )
      ) {
        try {
          data = await uploadImageResult(data, {
          operation: envelope,
          signal,
          send: (body) =>
            this.transport.tab(
              "/api/v1/tab/image",
              {
                ...body,
                ...this.ids(lease),
                bindingRevision: lease.bindingRevision,
                operationId: envelope.operationId,
              },
              lease.leaseCredential,
              { signal },
            ),
          });
        } catch (error) {
          if (envelope.tool === "generate_image")
            throw Object.assign(new Error("Generated output could not be delivered. Inspect the existing output file before another generation."), { code: "PARTIAL_EFFECT", effectState: "PARTIAL" });
          throw error;
        }
      }
      const inner =
        data && typeof data === "object"
          ? (data as Record<string, unknown>)
          : {};
      const phase =
        inner.status === "UNKNOWN" ||
        inner.status === "PARTIAL" ||
        inner.status === "REJECTED"
          ? inner.status
          : "SUCCEEDED";
      result = {
        operationId: envelope.operationId,
        status: phase,
        effectState:
          phase === "UNKNOWN"
            ? "POSSIBLE"
            : phase === "PARTIAL"
              ? "PARTIAL"
              : phase === "REJECTED"
                ? "NONE"
                : "VERIFIED",
        data,
        ...(typeof inner.revision === "string"
          ? { revision: inner.revision }
          : {}),
      };
      if (phase !== "SUCCEEDED") {
        const original =
          inner.error && typeof inner.error === "object"
            ? (inner.error as Record<string, unknown>)
            : {};
        const candidate = {
          code:
            original.code ??
            (phase === "PARTIAL"
              ? "PARTIAL_EFFECT"
              : phase === "UNKNOWN"
                ? "EFFECT_UNKNOWN"
                : "PROVIDER_REJECTED"),
          message: original.message ?? "Effect requires reconciliation.",
          retryable: false,
          recovery:
            original.recovery ??
            "Inspect operation_status and current source; do not replay uncertain effects.",
        };
        const checked = toolErrorSchema.safeParse(candidate);
        result.error = checked.success
          ? checked.data
          : {
              code: phase === "PARTIAL" ? "PARTIAL_EFFECT" : "EFFECT_UNKNOWN",
              message: "Effect requires reconciliation.",
              retryable: false,
              recovery:
                "Inspect operation_status and current source before another mutation.",
            };
      }
    } catch (error) {
      const e = error as { code?: string; effectState?: string };
      const code = errorCodes.includes(e.code as (typeof errorCodes)[number])
        ? e.code
        : e.code === "UNSUPPORTED_CONTROL"
          ? "UNSUPPORTED_INTERFACE"
          : "PROVIDER_REJECTED";
      const knownNoEffect = [
        "AUTH_REQUIRED",
        "SCOPE_DENIED",
        "REVOKED",
        "APPROVAL_REQUIRED",
        "TAB_OFFLINE",
        "TAB_BUSY",
        "BINDING_MISMATCH",
        "STALE_EPOCH",
        "STALE_REVISION",
        "NATIVE_CONFLICT",
        "UNSUPPORTED_INTERFACE",
        "INVALID_INPUT",
        "PATH_DENIED",
        "LIMIT_EXCEEDED",
        "QUEUE_FULL",
        "QUOTA_EXCEEDED",
        "CHALLENGE_REQUIRED",
        "FILE_NOT_FOUND",
        "BINARY_FILE",
        "PARSE_ERROR",
        "STORAGE_CORRUPT",
      ];
      const unknown =
        e.effectState === "UNKNOWN" ||
        (e.effectState !== "NONE" && code === "EFFECT_UNKNOWN") ||
        (e.effectState !== "NONE" &&
          !knownNoEffect.includes(code ?? "") &&
          toolByName.get(envelope.tool)?.mutating);
      const partial = e.effectState === "PARTIAL";
      // Only expose bounded, code-authored public API errors. Never forward
      // arbitrary native/preview/provider messages, source, URLs or tokens.
      const message = envelope.tool === 'set_viewport_size' &&
        typeof (error as {message?:unknown}).message === 'string' &&
        /^Viewport (?:reset|set):/.test((error as Error).message)
          ? (error as Error).message.slice(0,420)
          : envelope.tool === 'fetch_generator' &&
        typeof (error as {message?:unknown}).message === 'string' &&
        /^(?:fetch_generator\/(?:argument|public-api|scratch-commit):|Public (?:metadata|asset|generator|source|manifest)|Use a canonical public)/.test((error as Error).message)
          ? (error as Error).message.slice(0,400)
          : code === 'UNSUPPORTED_INTERFACE' && envelope.tool === 'save_generator'
            ? 'Save is disabled until gateway policy, native adapter acceptance and independent saved-source verification all pass.'
            : code === 'STALE_REVISION'
              ? 'Source revision changed; reread the affected state before a new operation.'
              : code === 'BINDING_MISMATCH'
                ? 'Bound Generator, Draft or native preview identity no longer matches.'
                : code === 'INVALID_INPUT'
                  ? `Tool input or provider response failed validation for ${envelope.tool}; no untrusted details are returned.`
                  : code === 'UNSUPPORTED_INTERFACE'
                    ? `A required verified native interface is unavailable for ${envelope.tool}.`
                    : code === 'PROVIDER_REJECTED'
                      ? `Public/provider operation ${envelope.tool} was rejected; inspect public API stage and network policy.`
                      : code === 'NATIVE_CONFLICT'
                        ? 'A native snapshot/manifest/preview readback differs from the intended revision.'
                        : 'Operation could not be completed; inspect its code, effect state and Workspace before further changes.';
      result = {
        operationId: envelope.operationId,
        status: partial ? "PARTIAL" : unknown ? "UNKNOWN" : "REJECTED",
        effectState: partial ? "PARTIAL" : unknown ? "POSSIBLE" : "NONE",
        error: {
          code: code ?? "EFFECT_UNKNOWN",
          message,
          retryable: false,
          recovery:
            "Use operation_status; reconcile uncertain effects before further writes.",
        },
      };
    }
    if (new TextEncoder().encode(JSON.stringify(result)).length > 256 * 1024)
      result = {
        operationId: envelope.operationId,
        status: result.status,
        effectState: result.effectState,
        ...(result.error ? { error: result.error } : {}),
        data: {
          resultOmitted: true,
          reason:
            "Inline result exceeded 256 KiB. Use paged reads or authenticated local artifact export; do not replay the operation.",
        },
      };
    operation.status = String(result.status);
    operation.result = result;
    operation.resultExpiresAt = Date.now() + 600000;
    await this.store.set(key, operation); // Terminal durable before reply; lost reply cannot repeat effect.
    await this.transport.tab(
      "/api/v1/tab/reply",
      {
        ...this.ids(lease),
        operationId: envelope.operationId,
        phase: result.status,
        result,
      },
      lease.leaseCredential,
    );
    if (result.status === "UNKNOWN" || result.status === "PARTIAL") {
      if (envelope.tool === "set_viewport_size") {
        // This tool can only apply iframe-local CSS and a fixed read-only
        // measurement probe. Preserve the PARTIAL/UNKNOWN durable receipt,
        // but do not kill the lease or block unrelated source operations.
        this.viewportUncertain = true;
        this.updateStatus({
          connection: "degraded",
          workspace: lease.workspaceId,
          reason: "Preview viewport could not be verified. Inspect its actual dimensions; source and provider writes were not dispatched by this tool.",
        });
      } else {
        this.stopped = true;
        this.updateStatus({
          connection: "blocked",
          workspace: lease.workspaceId,
          reason: "Uncertain or partial effect. Inspect and reconcile.",
        });
      }
    } else if (envelope.tool === "set_viewport_size" && result.status === "SUCCEEDED" &&
               envelope.args.reset === true) {
      this.viewportUncertain = false;
      this.updateStatus({connection:"connected",workspace:lease.workspaceId});
    }
  }
  private async syncResolvedLocal(
    vfs: VirtualFileSystem,
    workspaceId: string,
  ): Promise<void> {
    const held = (await vfs.unresolved()).filter(j=>!!j.gatewayOperationId);
    if (!held.length) return; // Browser-local UUIDs are not Gateway Operation IDs.
    let cursor: string | undefined, revision: number | undefined;
    for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
      const page = (await this.transport.request(
        "GET",
        "/api/v1/admin/activity" +
          (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""),
      )) as {
        items: Record<string, unknown>[];
        revision: number;
        cursor?: string | null;
      };
      if (revision !== undefined && page.revision !== revision)
        throw new Error(
          "Activity changed during resolution recovery. Refresh and reconnect.",
        );
      revision = page.revision;
      const resolved = page.items.find(
        (row) =>
          row.workspaceId === workspaceId && held.some(j=>j.gatewayOperationId===String(row.operationId)) &&
          row.resolution &&
          typeof row.resolution === "object" &&
          (row.resolution as Record<string, unknown>).resolvedByOperator === true,
      );
      if (resolved) {
        const snapshot = await vfs.snapshot();
        if ((resolved.resolution as {observedRevision?:unknown}).observedRevision !== snapshot.revision)
          throw new BrowserError('STALE_REVISION','The remote acknowledgement does not match the current native draft.');
        const decision = resolved.resolution as {
          timestamp?: number;
          observedDigest?: string;
        };
        if (decision.observedDigest !== snapshot.revision.split(":")[1])
          throw new Error("Resolution digest differs from current source.");
        // A resolved gateway operation is not authority to erase unrelated
        // local journal failures merely because they predate its timestamp.
        for (const journal of held.filter(j=>j.gatewayOperationId===String(resolved.operationId)))
          await vfs.acknowledgeReconciliation(journal.id, snapshot.revision);
        return;
      }
      cursor = page.cursor ?? undefined;
      if (!cursor) return;
    }
    throw new Error(
      "Activity pagination budget reached. Inspect the exact held operation before reconnecting.",
    );
  }
  private async pruneOperations(workspaceId: string): Promise<void> {
    const prefix = this.operationPrefix(workspaceId);
    const rows: { key: string; row: LocalOperation }[] = [];
    for (const key of (await this.store.list()).filter((k) =>
      k.startsWith(prefix),
    )) {
      const row = await this.store.get<LocalOperation>(key);
      if (row) rows.push({ key, row });
    }
    let retainedBytes = 0;
    for (const { key, row } of rows.sort(
      (a, b) => b.row.createdAt - a.row.createdAt,
    )) {
      if (row.result) {
        const size = new TextEncoder().encode(
          JSON.stringify(row.result),
        ).length;
        if (
          (row.resultExpiresAt ?? 0) <= Date.now() ||
          retainedBytes + size > 8 * 1024 * 1024
        ) {
          delete row.result;
          delete row.resultExpiresAt;
          await this.store.set(key, row);
        } else retainedBytes += size;
      }
    }
    const terminal = rows
      .filter((x) =>
        ["SUCCEEDED", "REJECTED", "CANCELLED"].includes(x.row.status),
      )
      .sort((a, b) => b.row.createdAt - a.row.createdAt);
    for (const [index, { key, row }] of terminal.entries())
      if (index >= 1000 || row.createdAt + 7 * 86400000 < Date.now())
        await this.store.delete(key);
    if (
      rows.filter(
        (x) =>
          ["RUNNING", "UNKNOWN", "PARTIAL"].includes(x.row.status) &&
          !x.row.resolvedByOperator,
      ).length >= 1000
    )
      throw Object.assign(
        new Error("Unresolved local operation budget exhausted."),
        { code: "QUOTA_EXCEEDED" },
      );
  }
  private async authorizeChild(
    name: string,
    args: Record<string, unknown>,
    context: RuntimeContext,
    lease: Lease,
  ): Promise<void> {
    if (
      this.stopped ||
      this.lease !== lease ||
      Date.now() >= lease.expiresAt ||
      context.signal.aborted ||
      Date.now() >= context.envelope.deadlineMs
    )
      throw Object.assign(new Error("Execution context expired."), {
        code: "TAB_OFFLINE",
      });
    const checked = validateToolCall(name, args);
    if (
      !permissionsForTool(name, checked).every(
        (p) =>
          lease.permissions.includes(p) &&
          context.envelope.permissions.includes(p),
      )
    )
      throw Object.assign(new Error("Child permission denied."), {
        code: "SCOPE_DENIED",
      });
    const permit = (await this.transport.tab(
      "/api/v1/tab/permit",
      {
        ...this.ids(lease),
        operationId: context.envelope.operationId,
        tool: name,
        args: checked,
      },
      lease.leaseCredential,
    )) as { permissions?: string[] };
    if (
      !Array.isArray(permit.permissions) ||
      !permissionsForTool(name, checked).every((p) =>
        permit.permissions!.includes(p),
      )
    )
      throw Object.assign(new Error("Child authorization revoked."), {
        code: "REVOKED",
      });
  }
  private async invoke(
    name: string,
    rawArgs: Record<string, unknown>,
    context: RuntimeContext,
    lease = this.lease,
  ): Promise<unknown> {
    if (
      !lease ||
      this.stopped ||
      Date.now() >= lease.expiresAt ||
      context.signal.aborted ||
      Date.now() >= context.envelope.deadlineMs
    )
      throw Object.assign(new Error("Lease/deadline expired."), {
        code: "TAB_OFFLINE",
      });
    const args = validateToolCall(name, rawArgs);
    if (
      !permissionsForTool(name, args).every(
        (p) =>
          lease.permissions.includes(p) &&
          context.envelope.permissions.includes(p),
      )
    )
      throw Object.assign(new Error("Permission denied."), {
        code: "SCOPE_DENIED",
      });
    if (name !== context.envelope.tool)
      await this.authorizeChild(name, args, context, lease);
    if (
      !this.identity ||
      !equalIdentity(await this.adapter.identity(), this.identity)
    )
      throw Object.assign(new Error("Identity changed."), {
        code: "BINDING_MISMATCH",
      });
    if (name === "attach_file") {
      const path = String(args.path),
        bytes = await context.vfs.read(path);
      const artifact = await this.artifacts.create(
        lease.workspaceId,
        lease.bindingRevision,
        typeof args.name === "string" ? args.name : path.split("/").pop()!,
        bytes,
      );
      return {
        ...artifact,
        delivery:
          "Authenticated operator download in Activity. This artifact has no public URL.",
      };
    }
    if (name === 'workspace_status' && this.source) {
      // Probe the real preview before telling the agent whether it is usable.
      // A broken optional preview must not prevent Workspace inspection.
      try { await this.tools?.preflightPreview?.(context); }
      catch { /* An optional preview cannot prevent authoritative status. */ }
      const base = await this.source.call(name, args) as Record<string, unknown>;
      const snapshotVerified = base.snapshotVerified === true;
      const localJournalVerified = base.localJournalError === null;
      const outstanding = Array.isArray(base.unresolved) ? base.unresolved as Array<{kind?:string;paths?:string[]}> : [];
      const pendingNative = outstanding.filter(row=>row.kind!=='IMPORT');
      const restrictedPaths = [...new Set(pendingNative.flatMap(row=>row.kind==='SAVE'
        ? ['main.pjs','index.html','src/**'] : Array.isArray(row.paths) ? row.paths : ['src/**']))].sort();
      const caps = base.capabilities as {
        nativeSave?:boolean;sourceRead?:boolean;sourceWrite?:boolean;
        sourceWriteBlocked?:string[];
      } | undefined;
      const authorized = [...new Set(lease.permissions)].sort();
      const gatewayObservation=this.transport.gatewayPolicySnapshot();
      const gatewayPolicy=gatewayObservation.providerWritesEnabled === true ||
        gatewayObservation.nativeActionsEnabled === true;
      const providerWritesEnabled=gatewayObservation.providerWritesEnabled;
      const nativeActionsEnabled=gatewayObservation.nativeActionsEnabled;
      const [nativeOwner,nativeSaveAccess]=await Promise.all([
        this.adapter.ownership(),this.adapter.canSave(),
      ]);
      // Cached policy is diagnostic, not authorization. The authoritative
      // Registry rechecks the current policy for every tool admission.
      const nativeDetected = caps?.nativeSave === true;
      const adapterAccepted = this.adapter.options.externalWritesVerified === true;
      const hasSaveGrant = authorized.includes('SAVE');
      const leaseHeld = this.lease === lease && !this.stopped && Date.now() < lease.expiresAt;
      const reasons = [
        ...(!nativeDetected ? ['NATIVE_SAVE_INTERFACE_UNAVAILABLE'] : []),
        ...(nativeOwner!==true ? ['NATIVE_OWNER_NOT_VERIFIED'] : []),
        ...(nativeSaveAccess!==true ? ['NATIVE_SAVE_ACCESS_NOT_VERIFIED'] : []),
        ...(!adapterAccepted ? ['NATIVE_SAVE_ACCEPTANCE_NOT_VERIFIED'] : []),
        ...(gatewayPolicy !== true ? [gatewayPolicy === false ? 'GATEWAY_PROVIDER_WRITES_DISABLED' : 'GATEWAY_POLICY_UNKNOWN'] : []),
        ...(!hasSaveGrant ? ['SAVE_PERMISSION_NOT_GRANTED'] : []),
        ...(!leaseHeld ? ['WRITER_LEASE_NOT_HELD'] : []),
        ...((caps?.sourceWriteBlocked ?? []).length ? ['NATIVE_EDITOR_MUTATION_BLOCKED'] : []),
        ...(!snapshotVerified ? ['SOURCE_READBACK_NOT_VERIFIED'] : []),
        ...(!localJournalVerified ? ['LOCAL_JOURNAL_NOT_VERIFIED'] : []),
        ...(pendingNative.length ? ['RECENT_NATIVE_EFFECT_SETTLING'] : []),
      ];
      return {
        ...base,
        lease: {
          held: leaseHeld, epoch: lease.epoch,
          bindingRevision: lease.bindingRevision,
          remainingMs: Math.max(0, lease.expiresAt - Date.now()),
        },
        effectivePermissions: authorized,
        effectiveCapabilities: {
          sourceRead: { detected:caps?.sourceRead === true,
            authorized:authorized.includes('READ_SOURCE'),
            available:leaseHeld && snapshotVerified && caps?.sourceRead === true && authorized.includes('READ_SOURCE'),
            ...(!snapshotVerified ? {reason:base.sourceReadbackError} : {}) },
          sourceWrite: { detected:caps?.sourceWrite === true,
            authorized:authorized.includes('WRITE_SOURCE'),
            available:leaseHeld && snapshotVerified && localJournalVerified && caps?.sourceWrite === true && authorized.includes('WRITE_SOURCE'),
            reasons:[...(caps?.sourceWriteBlocked ?? []),...(!snapshotVerified ? ['SOURCE_READBACK_NOT_VERIFIED'] : []),...(!localJournalVerified ? ['LOCAL_JOURNAL_NOT_VERIFIED'] : []),],
            restrictedPaths, pendingNativeOperations:pendingNative.length,
            recovery:'Other files remain editable. Matching current-source readback automatically clears stale local journals.' },
          saveGenerator: {
            detected:nativeDetected,adapterAccepted,gatewayPolicy,
            providerWritesEnabled,nativeActionsEnabled,
            nativeOwner,nativeSaveAccess,
            gatewayPolicyObservedAt:gatewayObservation.observedAt,
            gatewayPolicyIsLastObservation:true,
            authorized:hasSaveGrant,available:reasons.length===0,reasons,
          },
          lifecycle: {
            renameGenerator: {detected:!!this.lifecycle,
              authorized:authorized.includes('RENAME'),
              gatewayPolicy,
              available:!!this.lifecycle&&nativeOwner===true&&gatewayPolicy&&leaseHeld&&authorized.includes('RENAME')},
            setListing: {detected:!!this.lifecycle,
              authorized:authorized.includes('LISTING'),requiresOperatorConfirmation:true,
              gatewayPolicy,
              available:!!this.lifecycle&&nativeOwner===true&&gatewayPolicy&&leaseHeld&&authorized.includes('LISTING')},
          },
          preview: this.tools?.capabilityReport?.(context) ?? {
            inspection:'NOT_INSTRUMENTED',
          },
          policyBoundary: {
            privilegedSaveAndLifecycle:'Exact HAR-observed Save, Rename and Listing are available only with native ownership, current Grants and enabled gateway policy.',
            generatorRuntime:'Preview JavaScript can make normal generator requests; this is not equivalent to authorized privileged editor Save.',
          },
        },
      };
    }
    if (name === 'generator_info' && this.source) {
      const base = await this.source.call(name, args) as Record<string, unknown>;
      const identity = await this.adapter.assertIdentity();
      const revision = typeof base.revision === 'string' ? base.revision : null;
      let savedBaseRevision: Record<string, unknown>;
      try {
        const saved = await new SavedSourceReader().read(identity.slug, identity);
        await this.adapter.assertIdentity();
        savedBaseRevision = {known:true, value:saved.revision,
          provenance:'independent-complete-public-source-readback'};
      } catch (error) {
        const code = (error as {code?:unknown})?.code;
        savedBaseRevision = {known:false, value:null,
          reason: code === 'UNSUPPORTED_INTERFACE'
            ? 'Public source response did not attest a complete saved manifest.'
            : 'Independent saved-source readback was not verified.'};
      }
      if (this.stopped || this.lease !== lease || Date.now() >= lease.expiresAt)
        throw Object.assign(new Error('Lease lost during metadata verification.'), {code:'TAB_OFFLINE'});
      if (revision !== null && (await context.vfs.snapshot()).revision !== revision)
        throw Object.assign(new Error('Source changed during metadata verification.'), {code:'STALE_REVISION'});
      return {...base,savedBaseRevision};
    }
    if ((name === 'rename_generator' || name === 'set_listing') && this.lifecycle) {
      const permission=name==='rename_generator'?'RENAME':'LISTING';
      if(!lease.permissions.includes(permission) ||
        !context.envelope.permissions.includes(permission))
        throw Object.assign(new Error('Lifecycle permission is not granted.'),{code:'SCOPE_DENIED'});
      const snapshot=await context.vfs.snapshot();
      const native=await this.adapter.snapshot();
      if(snapshot.nativeRevision!==native.revision ||
        !equalIdentity(snapshot.identity,native.identity))
        throw Object.assign(new Error('Native Generator changed during lifecycle preflight.'),{code:'STALE_REVISION'});
      let approval:LifecycleApproval|undefined;
      if(name==='set_listing'){
        if(!this.confirmNativeAction)
          throw Object.assign(new Error('A native Operator confirmation interface is unavailable.'),{code:'APPROVAL_REQUIRED'});
        const choice=args.listing;
        const allowed=this.confirmNativeAction(
          'Perch MCP: change the listing of '+native.identity.slug+' to '+String(choice)+
          '? This changes public discoverability. Anyone with the URL can still open an Unlisted generator.');
        if(!allowed)
          throw Object.assign(new Error('The Operator did not approve the listing change.'),{code:'APPROVAL_REQUIRED'});
        approval={
          tool:name,target:native.identity,
          inputDigest:await lifecycleApprovalDigest(name,args,native.identity,native.revision,lease.epoch),
          sourceRevision:native.revision,epoch:lease.epoch,
          expiresAt:Date.now()+30000,consumed:false,
        };
      }
      if(this.stopped || this.lease!==lease || Date.now()>=lease.expiresAt)
        throw Object.assign(new Error('Lease expired before native lifecycle dispatch.'),{code:'TAB_OFFLINE'});
      return this.lifecycle.call(name,args,{
        operationId:context.envelope.operationId,epoch:lease.epoch,
        expectedRevision:native.revision,
        permissions:context.envelope.permissions,
        approval,
      });
    }
    if (name === 'save_generator' && this.source) {
      // The gateway refuses this tool until global provider acceptance is
      // enabled. Local adapter acceptance is separate and cannot be bypassed
      // by an MCP argument or an ordinary source-write Grant.
      if (this.adapter.options.externalWritesVerified !== true)
        throw Object.assign(new Error('Native Save has not passed real disposable-generator acceptance.'),
          {code:'UNSUPPORTED_INTERFACE'});
      const desired=await context.vfs.snapshot();
      if (desired.revision !== args.intendedRevision)
        throw Object.assign(new Error('Draft changed before native Save preflight.'),
          {code:'STALE_REVISION'});
      const identity=await this.adapter.assertIdentity();
      const readback=new SavedSourceReader();
      const previousSavedSnapshot=await readback.read(identity.slug,identity);
      if (this.stopped || this.lease!==lease || Date.now()>=lease.expiresAt)
        throw Object.assign(new Error('Save lease was lost during independent base read.'),
          {code:'TAB_OFFLINE'});
      return this.source.call(name,args,{save:{
        operationId:context.envelope.operationId,
        permission:lease.permissions.includes('SAVE')&&context.envelope.permissions.includes('SAVE'),
        previousSavedSnapshot,
        readSavedSnapshot:()=>readback.read(identity.slug,identity),
      }});
    }
    if (this.source?.supports(name)) return this.source.call(name, args, {operationId:context.envelope.operationId});
    if (this.tools?.supports(name)) return this.tools.call(name, args, context);
    throw Object.assign(
      new Error("No verified authorized adapter for this capability."),
      { code: "UNSUPPORTED_INTERFACE" },
    );
  }
}
