import { withSqlUsage } from "./sql-meter.js";
import { ImageTransferHandler } from "./image-transfer.js";
import { MusicHandler } from "./media/handler.js";
import type { DurableObjectState, WebSocket as DurableSocket } from "@cloudflare/workers-types";
import {
  ApiError,
  bearer,
  canonical,
  digest,
  errorResponse,
  id,
  json,
  omitDevelopmentResult,
  parseBody,
  operationTimeoutMs,
  randomSecret,
  registry,
  rpc,
  str,
  type Env,
} from "./common.js";
import { SqlRecords } from "./sql.js";
import { OperationStore, operationReceiptDigest } from "./operation-store.js";
import { MaintenanceIndex } from "./maintenance-index.js";
import { PushNotifications } from "./push-notifications.js";
import { reserveAdmission, admissionBudgetPolicy, admissionBudgetSnapshot, type BudgetVector, type RetainedCleanupSummary } from "./admission-budget.js";
import {
  toolDefinitions,
  validateToolCall,
  toolResultSchema,
  permissionsForTool,
} from "../../../packages/contracts/src/index.js";
import { operationKeySchema, segmentRequestSchema } from '../../../packages/contracts/src/operations-v2.js';
import { keyScope, OperationKeys } from './operation-keys.js';
import { encodeTarget } from '../../../packages/contracts/src/target.js';
import type { AuthProps, WorkspaceRecord } from "./registry.js";
import { isTerminalViewportEffect } from "../../../packages/contracts/src/effect-policy.js";
interface TransitionFence { id: string; bindingRevision: number; epoch: number; serial: number; aborted?: true }
interface Lease {
  contractVersion?: 2;
  assignmentGeneration?: number;
  bindingGeneration?: number;
  workspaceId: string;
  epoch: number;
  bindingRevision: number;
  tabInstanceId: string;
  secretHash: string;
  claimedAt?: number;
  expiresAt: number;
  credentialEpoch: number;
  permissions: string[];
}
interface Operation {
  operationId: string;
  target?: string;
  operationKey?: string;
  policyRevision?: number;
  permissionRevision?: number;
  cancelRequested?: true;
  sequence: number;
  argsDigest: string;
  workspaceId: string;
  epoch: number;
  bindingRevision: number;
  tabInstanceId: string;
  deadlineMs: number;
  tool: string;
  args?: Record<string, unknown>;
  permissions: string[];
  requiredPermissions: string[];
  mutating: boolean;
  props: AuthProps;
  agentId: string;
  traceId: string;
  phase: string;
  result?: unknown;
  createdAt: number;
  terminalAt?: number;
  terminalNotified?: boolean;
  terminalErrorCode?: string;
  terminalEffectState?: 'NONE' | 'KNOWN';
  resolution?: unknown;
  lateObservation?: unknown;
  terminalResultDigest?: string;
  dispatchAttempt?: {id:string;reconcileAt:number};
  budgetReservation?: BudgetVector;
}
export class Workspace {
  private db: SqlRecords;
  private operations: OperationStore<Operation>;
  private journal: OperationStore<Operation>;
  private maintenance: MaintenanceIndex;
  private music: MusicHandler<Operation>;
  private push: PushNotifications;
  private mediaPreparing=false;
  private images: ImageTransferHandler<Operation>;
  private terminalDrain?: Promise<void>;
  private keysV2?: OperationKeys;
  private operationKeys(): OperationKeys {
    // Installation of the new table never touches a v1 operation.
    return this.keysV2 ??= new OperationKeys(this.db);
  }
  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {
    this.db = new SqlRecords(state.storage);
    const schema = this.db.get<number>("schema");
    const nativeMarker = schema===2 && this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='operation_migration_v2'").length &&
      this.db.query<{stage:string}>("SELECT stage FROM operation_migration_v2 WHERE id=1")[0]?.stage==='NATIVE';
    if (schema !== undefined && schema !== 1 && !nativeMarker)
      throw new ApiError(
        "INCOMPATIBLE_VERSION",
        "Workspace schema is newer than this Worker.",
        409,
      );
    if (schema === undefined) this.db.put("schema", 1);
    this.operations = new OperationStore<Operation>(this.db, env.CANONICAL_STORAGE_MODE ?? "legacy");
    this.journal = this.operations;
    this.push=new PushNotifications(this.db,this.state,{
      enabled:env.PUSH_NOTIFICATIONS_ENABLED==="true",getLease:()=>this.db.get<Lease|undefined>("lease"),
      allowedOrigins:["https://perchance.org",...(env.ALLOWED_ORIGINS??"").split(",").map(s=>s.trim()).filter(Boolean),...(env.ISSUER_URL?[env.ISSUER_URL]:[])],
    });
    // Recover only an already-created media catalog. Ordinary reads never
    // initialize unrelated media tables or enumerate retained music history.
    if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='media_prepare_v1'").length)
      this.mediaPreparing=this.db.query("SELECT 1 AS pending WHERE EXISTS(SELECT 1 FROM media_prepare_v1 WHERE complete=0 LIMIT 1) OR EXISTS(SELECT 1 FROM media_dirty_v1 LIMIT 1)").length>0;
    this.maintenance = new MaintenanceIndex(this.db,undefined,()=>this.operations.native);
    this.images = new ImageTransferHandler(this.db, {
      getLease: () => this.db.get<Lease>("lease"),
      getOperation: (operationId) =>
        this.operations.get("operation/" + operationId),
      binaryPayloadsEnabled:()=>this.env.BINARY_PAYLOADS_ENABLED==="true"&&this.operations.native,
      onStoragePreparationPending:()=>this.requestMediaPreparation(),
      authorize: async (op) => {
        const fresh = await rpc<{ workspace: WorkspaceRecord }>(
          registry(this.env),
          "/internal/authorize",
          {
            props: op.props,
            agentId: op.agentId,
            ...(op.target ? { target: op.target } : {}),
            permissions: op.requiredPermissions,
            mutating: false,
          },
        );
        if (
          fresh.workspace.epoch !== op.epoch ||
          fresh.workspace.bindingRevision !== op.bindingRevision
        )
          throw new ApiError(
            "STALE_EPOCH",
            "Image operation binding changed.",
            409,
          );
      },
    });
    this.music = new MusicHandler<Operation>(this.db, this.env, {
      getLease: () => this.db.get<Lease>("lease"),
      getOperation:operationId=>this.operations.get("operation/"+operationId),
      putOperation:op=>this.operations.put("operation/"+op.operationId,op),
      binaryPayloadsEnabled:()=>this.env.BINARY_PAYLOADS_ENABLED==="true"&&this.operations.native,
      onStoragePreparationPending:()=>this.requestMediaPreparation(),
      authorize: async (op, action) => {
        const result = await rpc<{ workspace: WorkspaceRecord }>(
          registry(this.env),
          action === "start" ? "/internal/dispatch" : "/internal/authorize",
          {
            props: op.props,
            agentId: op.agentId,
            permissions: ["MEDIA", "WRITE_SOURCE"],
            mutating: action === "start",
            workspaceId: op.workspaceId,
            bindingRevision: op.bindingRevision,
            epoch: op.epoch,
            operationId: op.operationId,
          },
        );
        if (
          result.workspace.epoch !== op.epoch ||
          result.workspace.bindingRevision !== op.bindingRevision
        )
          throw new ApiError(
            "STALE_EPOCH",
            "Music operation binding changed.",
            409,
          );
      },
    });
  }
  async fetch(request: Request): Promise<Response> {
    return withSqlUsage(this.env.SQL_TELEMETRY_ENABLED==="true","workspace",new URL(request.url).pathname,()=>this.fetchMetered(request));
  }
  private async fetchMetered(request: Request): Promise<Response> {
    let response: Response;
    const maintenance = { settled: false };
    try {
      response = await this.route(request, maintenance);
    } catch (error) {
      response = errorResponse(error);
    }
    // Invalid public requests must not amplify maintenance work. An alarm or
    // next authorized request drains any pending canonical terminal state.
    const path = new URL(request.url).pathname;
    if (response.ok && this.operations.migrating && path !== "/internal/sql-usage" && path !== "/internal/migration") {
      try { this.operations.prepareStep(); await this.scheduleAlarm(); }
      catch { console.error(JSON.stringify({kind:"workspace-migration-deferred"})); }
    }
    if (this.operations.journalReady && !maintenance.settled && path !== "/internal/sql-usage" && (response.ok || path.startsWith("/internal/"))) {
      try {await this.drainTerminalOutbox();}
      catch {console.error(JSON.stringify({kind:"workspace-maintenance-deferred"}));}
    }
    return response;
  }
  async alarm(): Promise<void> {
    return withSqlUsage(this.env.SQL_TELEMETRY_ENABLED==="true","workspace","alarm",async()=>{
      if(this.operations.migrating)this.operations.prepareStep();
      if(this.mediaPreparing){const imagesReady=this.images.prepareStorage(),musicReady=this.music.prepareStorage();this.mediaPreparing=!(imagesReady&&musicReady);}
      if(!this.operations.journalReady){await this.scheduleAlarm();return;}
      this.expire();
      if (this.env.DEVELOPMENT_CONTRACT_V2_ENABLED === 'true' &&
          this.db.query("SELECT name FROM sqlite_master WHERE name='operation_key_v2'").length)
        this.db.transaction(() => this.operationKeys().maintain(Date.now(),
          operationId => this.operations.get('operation/' + operationId) !== undefined));
      await this.drainTerminalOutbox();
    });
  }
  webSocketMessage(socket:DurableSocket,message:string|ArrayBuffer):void {this.push.webSocketMessage(socket,message);}
  webSocketClose(socket:DurableSocket,code:number,_reason:string,_wasClean:boolean):void {this.push.webSocketClose(socket,code);}
  webSocketError(socket:DurableSocket,_error:unknown):void {this.push.webSocketError(socket);}
  private async scheduleAlarm(retryAt?: number): Promise<void> {
    const deadlines: number[] = [];
    if(this.operations.migrating||this.mediaPreparing)deadlines.push(Date.now()+1000);
    if(!this.operations.journalReady) {
      const existing=await this.state.storage.getAlarm();
      if(deadlines.length){const next=Date.now()+1000;if(existing===null||existing<=Date.now()||next<existing)await this.state.storage.setAlarm(next);}
      else if(existing!==null)await this.state.storage.deleteAlarm();
      return;
    }
    const due = this.journal.nextDue();
    const keyDue = this.keysV2?.nextDue();
    if (keyDue !== undefined) deadlines.push(keyDue);
    if (due !== undefined) deadlines.push(due);
    if (this.journal.pendingExists()) deadlines.push(retryAt ?? Date.now() + 1000);
    if (this.journal.stats().eligible > 1000) deadlines.push(Date.now());
    const maintenanceDue=this.maintenance.nextDue();
    if(maintenanceDue!==undefined)deadlines.push(maintenanceDue);
    const existing = await this.state.storage.getAlarm();
    if (!deadlines.length) {
      if (existing !== null) await this.state.storage.deleteAlarm();
      return;
    }
    const next = Math.max(Date.now() + 1000, Math.min(...deadlines));
    if (existing === null || existing <= Date.now() || next < existing)
      await this.state.storage.setAlarm(next);
  }
  private drainTerminalOutbox(): Promise<void> {
    // Requests may interleave at RPC awaits. Receipt dedup remains durable;
    // this promise only prevents duplicate concurrent drain attempts in one instance.
    if (this.terminalDrain) return this.terminalDrain;
    const pending = this.drainTerminalOutboxOnce();
    this.terminalDrain = pending;
    void pending.finally(() => { if (this.terminalDrain === pending) this.terminalDrain = undefined; }).catch(() => {});
    return pending;
  }
  private async drainTerminalOutboxOnce(): Promise<void> {
    let failed = false;
    const retryAt = this.journal.pendingExists() ? this.db.get<number>("outbox-retry-at", 0) : 0;
    if (retryAt > Date.now()) {
      // Ordinary traffic must not bypass a durable outage backoff.
      try { await this.scheduleAlarm(retryAt); } catch { /* Retain durable outbox. */ }
      return;
    }
    for (const {key} of this.journal.pendingKeys()) {
      const op=this.operations.get(key);
      if(!op?.terminalAt||op.terminalNotified)continue;
      const error = (op.result as { error?: { code?: unknown } } | undefined)
        ?.error;
      const errorCode =
        op.terminalErrorCode ??
        (typeof error?.code === "string" &&
        /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
          ? error.code
          : op.phase === "UNKNOWN"
            ? "EFFECT_UNKNOWN"
            : op.phase === "PARTIAL"
              ? "PARTIAL_EFFECT"
              : op.phase === "CANCELLED"
                ? "CANCELLED"
                : undefined);
      try {
        await rpc(registry(this.env), "/internal/terminal", {
          workspaceId: op.workspaceId,
          operationId: op.operationId,
          tool: op.tool,
          status: op.phase,
          epoch: op.epoch,
          bindingRevision: op.bindingRevision,
          traceId: op.traceId,
          timestamp: op.terminalAt,
          durationMs: Math.max(0, op.terminalAt! - op.createdAt),
          ...(errorCode ? { errorCode } : {}),
          ...(op.resolution ? { resolution: op.resolution } : {}),
        });
        this.db.transaction(() => {
          const current = this.operations.get("operation/" + op.operationId);
          if (current && current.phase === op.phase && current.terminalAt === op.terminalAt &&
              canonical(current.resolution) === canonical(op.resolution) && !current.terminalNotified) {
            current.terminalNotified = true;
            this.operations.put("operation/" + current.operationId, current);
          }
        });
      } catch {
        failed = true;
        break;
      }
    }
    let nextRetry: number | undefined;
    if (failed) {
      this.db.transaction(() => {
        const delay = Math.min(60000, this.db.get<number>("outbox-backoff", 500) * 2);
        nextRetry = Date.now() + delay;
        this.db.put("outbox-backoff", delay);
        this.db.put("outbox-retry-at", nextRetry);
      });
    } else if (this.db.get<number>("outbox-backoff") !== undefined ||
               this.db.get<number>("outbox-retry-at") !== undefined) {
      // Clear historical backoff only once; idle polling never rewrites it.
      this.db.transaction(() => {
        this.db.delete("outbox-backoff");
        this.db.delete("outbox-retry-at");
      });
    }
    try {
      await this.scheduleAlarm(nextRetry);
    } catch {
      /* Persistent terminal rows remain the outbox for the next request/alarm. */
    }
  }
  private expire(): void {
    this.db.transaction(() => {
      const now = Date.now();
      const maintenance=this.maintenance.due(now);
      for(const {key,kind} of maintenance)if(kind==="retired"){
        const lease=this.db.get<Lease>(key);
        if(lease&&lease.expiresAt+86400000<now)this.db.delete(key);
      }
      const imageKeys=maintenance.filter(row=>row.kind==="image").map(row=>row.key);
      const musicKeys=maintenance.filter(row=>row.kind==="music").map(row=>row.key);
      if(imageKeys.length)this.images.expire(imageKeys);
      if(musicKeys.length)this.music.expire(musicKeys);
      for (const op of this.journal.due(now)) this.expireOperation(op, now);
      for (const {key} of this.journal.excessRetention()) this.operations.delete(key);
    });
  }
  /** Expire exactly one canonical record. Returns true only when retention deleted it. */
  private expireOperation(op: Operation, now: number): boolean {
    const terminalCode = (
      op.result as { error?: { code?: unknown } } | undefined
    )?.error?.code;
    if (
      op.terminalAt &&
      !op.terminalErrorCode &&
      typeof terminalCode === "string" &&
      /^[A-Z][A-Z0-9_]{0,63}$/.test(terminalCode)
    ) {
      op.terminalErrorCode = terminalCode;
      this.operations.put("operation/" + op.operationId, op);
    }
    if (
      ![
        "SUCCEEDED",
        "REJECTED",
        "UNKNOWN",
        "PARTIAL",
        "CANCELLED",
      ].includes(op.phase) &&
      (op.deadlineMs <= now || (op.dispatchAttempt && op.dispatchAttempt.reconcileAt <= now))
    ) {
      op.phase = op.phase === "ADMITTED" && !op.dispatchAttempt ? "REJECTED" : "UNKNOWN";
      op.result = {
        operationId: op.operationId,
        status: op.phase,
        effectState: op.phase === "UNKNOWN" ? "POSSIBLE" : "NONE",
        error: {
          retryable: false,
          recovery:
            op.phase === "UNKNOWN"
              ? "Inspect native source and reconcile the exact operation; do not replay."
              : "No dispatch occurred; inspect current status before retry.",
          code: op.phase === "UNKNOWN" ? "EFFECT_UNKNOWN" : "TIMEOUT",
          message:
            op.phase === "UNKNOWN"
              ? "Dispatched effect requires reconciliation."
              : "Deadline expired before dispatch.",
        },
      };
      op.terminalAt = now;
      op.terminalErrorCode = op.phase === "UNKNOWN" ? "EFFECT_UNKNOWN" : "TIMEOUT";
      op.terminalResultDigest = operationReceiptDigest(op.result);
      delete op.args;
      this.operations.put("operation/" + op.operationId, op);
    } else if (
      op.terminalAt &&
      op.terminalAt + 600000 <= now &&
      op.result !== undefined
    ) {
      op.terminalResultDigest ??= operationReceiptDigest(op.result);
      if (op.target && op.phase === 'SUCCEEDED')
        op.terminalEffectState ??= this.successfulEffect(op);
      delete op.result;
      this.operations.put("operation/" + op.operationId, op);
    }
    if (op.terminalAt && op.terminalNotified &&
        (!["UNKNOWN","PARTIAL"].includes(op.phase) || op.resolution || isTerminalViewportEffect(op)) &&
        op.createdAt + 7 * 86400000 <= now)
      { this.operations.delete("operation/" + op.operationId); return true; }
    return false;
  }
  private lease(
    hash: string,
    b: Record<string, unknown>,
    terminalOnly = false,
  ): Lease {
    let l = this.db.get<Lease>("lease");
    if (
      terminalOnly &&
      (!l || l.epoch !== b.epoch || l.tabInstanceId !== b.tabInstanceId)
    )
      l = this.db.get<Lease>(
        "retired/" + String(b.epoch) + "/" + String(b.tabInstanceId),
      );
    if (
      !l ||
      hash !== l.secretHash ||
      l.expiresAt + (terminalOnly ? 86400000 : 0) <= Date.now() ||
      b.workspaceId !== l.workspaceId ||
      b.epoch !== l.epoch ||
      b.tabInstanceId !== l.tabInstanceId
    )
      throw new ApiError(
        "STALE_EPOCH",
        "Lease invalid, expired or belongs to another document.",
        409,
      );
    return l;
  }
  private cancelUndispatched(op: Operation, message: string): void {
    op.phase = 'CANCELLED';
    op.result = {
      operationId: op.operationId,
      status: 'CANCELLED',
      effectState: 'NONE',
      error: { code: 'CANCELLED', message, retryable: false,
        recovery: 'No effect occurred. Inspect current source before starting new work.' },
    };
    op.terminalAt = Date.now();
    delete op.args;
    delete op.dispatchAttempt;
    this.operations.put('operation/' + op.operationId, op);
  }
  private async authorizeScopedResult(op: Operation, b: Record<string, unknown>): Promise<void> {
    const props = b.props as AuthProps | undefined;
    if (!op.target || op.props.contractVersion !== 2 || props?.contractVersion !== 2 ||
        op.target !== b.target || op.props.grantId !== props.grantId || op.agentId !== b.agentId)
      throw new ApiError('NOT_FOUND', 'Operation not found in this scope.', 404);
    await rpc(registry(this.env), '/internal/authorize', {
      props, agentId: op.agentId, target: op.target, permissions: op.requiredPermissions, resultAccess: true,
    });
  }
  private successfulEffect(op: Operation): 'NONE' | 'KNOWN' {
    const retained = op.result as {effectState?: unknown} | undefined;
    return op.terminalEffectState ?? (op.mutating && retained?.effectState !== 'NONE' ? 'KNOWN' : 'NONE');
  }
  private summary(op: Operation): Record<string, unknown> {
    const now = Date.now();
    const expiredResult = op.terminalAt !== undefined && op.terminalAt + 600_000 <= now;
    const result = op.result as {data?: {resultAvailability?: unknown}} | undefined;
    const inFlightEffect = op.mutating && op.terminalAt === undefined &&
      (op.phase === 'DISPATCHED' || op.phase === 'RUNNING' || op.dispatchAttempt !== undefined);
    const resultAvailability = expiredResult ? 'EXPIRED'
      : op.terminalAt !== undefined && (result === undefined || result?.data?.resultAvailability === 'TOO_LARGE')
        ? 'TOO_LARGE' : undefined;
    return {
      operationId: op.operationId,
      ...(op.target ? {contractVersion: 2, target: op.target, operationKey: op.operationKey,
        traceId: op.traceId, serverTimeMs: now, phase: op.phase,
        effectState: op.phase === 'UNKNOWN' || inFlightEffect ? 'UNKNOWN' : op.phase === 'PARTIAL' ? 'PARTIAL' :
          op.phase === 'SUCCEEDED' ? this.successfulEffect(op) : 'NONE',
        ...(resultAvailability ? {resultAvailability} : {}),
        ...(op.cancelRequested ? {cancelRequested: true} : {})} : {}),
      status: op.phase,
      workspaceId: op.workspaceId,
      tool: op.tool,
      createdAt: op.createdAt,
      argsDigest: op.argsDigest,
      epoch: op.epoch,
      bindingRevision: op.bindingRevision,
      ...(op.resolution ? { resolution: op.resolution } : {}),
      ...(op.lateObservation ? { lateObservation: op.lateObservation } : {}),
      ...(op.result === undefined || expiredResult
        ? op.terminalAt
          ? {
              error: {
                code: "RESULT_EXPIRED",
                message:
                  "Transient result expired; operation was not re-executed.",
              },
            }
          : {}
        : { data: op.result }),
    };
  }
  /** Read-only shortcut; never reconcile, authorize or dispatch from a derived snapshot.
   * Dirty records, active work, outbox, expired deadlines, missing alarm or
   * retention backlog fall through to the normal bounded maintenance path. */
  private async idlePollState(): Promise<{ lastActivityAt: number } | undefined> {
    const row = this.db.query<{ operationDue: number | null; maintenanceDue: number | null; lastActivity: number | null }>(
      this.operations.native ? `SELECT
        (SELECT due FROM operation_native_v2 WHERE due IS NOT NULL ORDER BY due LIMIT 1) AS operationDue,
        (SELECT due FROM workspace_maintenance_v2 WHERE due IS NOT NULL ORDER BY due LIMIT 1) AS maintenanceDue,
        lastTerminal AS lastActivity FROM operation_native_stats_v2 WHERE id=1 AND eligible<=1000
        AND activeCount=0 AND pendingCount=0
        AND NOT EXISTS(SELECT 1 FROM workspace_maintenance_dirty_v2 LIMIT 1)
        AND NOT EXISTS(SELECT 1 FROM records WHERE key>='outbox-' AND key<'outbox-\uffff' LIMIT 1)
        AND NOT EXISTS(SELECT 1 FROM workspace_maintenance_prepare_v2 WHERE complete=0 LIMIT 1)` :
      `SELECT (SELECT due FROM operation_index_v1 WHERE due IS NOT NULL ORDER BY due LIMIT 1) AS operationDue,
        (SELECT due FROM workspace_maintenance_v2 WHERE due IS NOT NULL ORDER BY due LIMIT 1) AS maintenanceDue,
        (SELECT terminal FROM operation_index_v1 ORDER BY terminal DESC LIMIT 1) AS lastActivity
       FROM operation_index_state_v1 WHERE id=1 AND eligible<=1000
        AND NOT EXISTS(SELECT 1 FROM operation_dirty_v1 LIMIT 1)
        AND NOT EXISTS(SELECT 1 FROM workspace_maintenance_dirty_v2 LIMIT 1)
        AND NOT EXISTS(SELECT 1 FROM operation_index_v1 WHERE active=1 LIMIT 1)
        AND NOT EXISTS(SELECT 1 FROM operation_index_v1 WHERE pending=1 LIMIT 1)
        AND NOT EXISTS(SELECT 1 FROM records WHERE key>='outbox-' AND key<'outbox-\uffff' LIMIT 1)
        AND NOT EXISTS(SELECT 1 FROM workspace_maintenance_prepare_v2 WHERE complete=0 LIMIT 1)`
    )[0];
    if(!row)return undefined;
    const due=Math.min(row.operationDue??Infinity,row.maintenanceDue??Infinity);
    if(due<=Date.now())return undefined;
    if(Number.isFinite(due)){
      const alarm=await this.state.storage.getAlarm();
      // Never replace an alarm using a potentially stale snapshot after await.
      // A missing/late alarm is repaired by ordinary maintenance instead.
      if(alarm===null||alarm<=Date.now()||alarm>due+1000||due<=Date.now())return undefined;
    }
    return {lastActivityAt:row.lastActivity??0};
  }
  private requestMediaPreparation():void {
    this.mediaPreparing=true;
    // The caller may be a failed admission transaction. Schedule only after
    // that synchronous transaction has committed or rolled back.
    const prepare=Promise.resolve().then(()=>this.scheduleAlarm()).catch(()=>{});
    if(typeof this.state.waitUntil==="function")this.state.waitUntil(prepare);
    else void prepare;
  }
  /** Rollover-only conservative cleanup allocation; never reads artifact bodies. */
  private retainedCleanupSummary():RetainedCleanupSummary {
    const retained=this.operations.retainedOperationSummary();
    const metadata=(status:Record<string,unknown>,prefix:string):{count:number;bytes:number}=>{
      const value=status.metadata;
      if(value&&typeof value==="object"&&!Array.isArray(value)) {
        const m=value as Record<string,unknown>;
        if(m.stage==="READY"&&Number.isSafeInteger(m.indexedCount)&&Number(m.indexedCount)>=0&&Number.isSafeInteger(m.indexedReservedBytes)&&Number(m.indexedReservedBytes)>=0)
          return {count:Number(m.indexedCount),bytes:Number(m.indexedReservedBytes)};
      }
      if(!this.db.query("SELECT key FROM records WHERE key>=? AND key<? LIMIT 1",prefix,prefix+"\uffff").length)return {count:0,bytes:0};
      this.requestMediaPreparation();
      throw new ApiError("GATEWAY_DEGRADED","Retained media accounting is preparing; no new operation was admitted.",503,"Preserve pending results and wait for bounded storage preparation.");
    };
    const image=metadata(this.images.storageStatus(),"image/manifest/"),music=metadata(this.music.storageStatus(),"music/journal/");
    const retired=this.db.query<{key:string}>("SELECT key FROM records WHERE key>=? AND key<? AND part=0 ORDER BY key LIMIT 4097","retired/","retired/\uffff");
    if(retired.length>4096)throw new ApiError("GATEWAY_DEGRADED","Retained lease accounting exceeds its bounded verification window.",503);
    return {nativeOperations:this.operations.native,...retained,imageBytes:image.bytes,imageManifests:image.count,musicBytes:music.bytes,musicJournals:music.count,retiredLeases:retired.length};
  }
  /** Only the Worker admin router may call this fixed migration surface. */
  private migrationAction(b:Record<string,unknown>):Record<string,unknown> {
    const action=b.action??"status";
    if(action==="status") {
      let maintenanceReady:boolean|null=null;
      try{maintenanceReady=this.maintenance.idleReady();}catch{ /* Unknown readiness is explicit. */ }
      const status=(read:()=>Record<string,unknown>):Record<string,unknown>=>{try{return read();}catch{return {metadata:{stage:"UNAVAILABLE"}};}};
      return {...this.operations.progress(),maintenanceReady,media:{image:status(()=>this.images.storageStatus()),music:status(()=>this.music.storageStatus())}};
    }
    if(action!=="step"&&action!=="resume")throw new ApiError("INVALID_INPUT","Unknown storage migration action.");
    if(this.operations.progress().stage==="LEGACY")throw new ApiError("INCOMPATIBLE_VERSION","Set CANONICAL_STORAGE_MODE to prepare or native before starting migration.",409);
    const key=id(b.idempotencyKey,"idempotencyKey"),workspaceId=id(b.workspaceId,"workspaceId");
    const requestDigest=operationReceiptDigest({workspaceId,action});
    this.db.query("CREATE TABLE IF NOT EXISTS operation_migration_actions_v2 (key TEXT PRIMARY KEY,digest TEXT NOT NULL,response TEXT NOT NULL,expires INTEGER NOT NULL) WITHOUT ROWID");
    this.db.query("CREATE INDEX IF NOT EXISTS operation_migration_actions_expiry_v2 ON operation_migration_actions_v2(expires)");
    try {
      return this.db.transaction(()=>{
        const now=Date.now();
        const prior=this.db.query<{digest:string;response:string;expires:number}>("SELECT digest,response,expires FROM operation_migration_actions_v2 WHERE key=?",key)[0];
        if(prior&&prior.expires>now) {
          if(prior.digest!==requestDigest)throw new ApiError("CONFLICT","Migration idempotency key has a different action.",409);
          return JSON.parse(prior.response) as Record<string,unknown>;
        }
        if(prior)this.db.query("DELETE FROM operation_migration_actions_v2 WHERE key=?",key);
        for(const row of this.db.query<{key:string}>("SELECT key FROM operation_migration_actions_v2 WHERE expires<=? ORDER BY expires LIMIT 16",now))
          this.db.query("DELETE FROM operation_migration_actions_v2 WHERE key=?",row.key);
        if(this.db.query<{count:number}>("SELECT COUNT(*) AS count FROM operation_migration_actions_v2")[0]!.count>=128)
          throw new ApiError("QUOTA_EXCEEDED","Migration action receipts are full; wait for their 24-hour expiry.",429);
        const result=action==="step"?this.operations.prepareStep():this.operations.resumeMigration();
        this.db.query("INSERT INTO operation_migration_actions_v2 VALUES(?,?,?,?)",key,requestDigest,JSON.stringify(result),now+86400000);
        return result;
      });
    } catch(error) {
      // A failure writing the idempotency receipt also rolls back cutover.
      // Restore the cache from durable authority before serving another call.
      this.operations.refreshMigrationState();
      if(error instanceof Error&&error.message==="SQLITE_RECORD_CORRUPT")this.operations.blockMigration();
      throw error;
    }
  }
  private async route(request: Request, maintenance: {settled:boolean}): Promise<Response> {
    const path = new URL(request.url).pathname;
    if(path==="/api/v1/tab/socket"){maintenance.settled=true;return this.push.upgrade(request);}
    const b=await parseBody(request);
    if (path === "/internal/sql-usage") return json(this.db.snapshotUsage());
    if (path === "/internal/migration") {
      maintenance.settled=true;
      const result=this.migrationAction(b);
      if(b.action==="step"||b.action==="resume") {
        try {await this.scheduleAlarm();}catch{console.error(JSON.stringify({kind:"workspace-migration-alarm-deferred"}));}
      }
      return json(result);
    }
    if (path.startsWith("/internal/") && !["/internal/status", "/internal/cancel"].includes(path) &&
        (path!=="/internal/recovery"||this.operations.journalReady)) this.expire();
    if (path === '/internal/settle-transition') {
      if (!this.operations.journalReady)
        throw new ApiError('TRANSITION_BLOCKED', 'Operation journal is preparing its authority.', 409);
      const transitionId = id(b.transitionId);
      const epoch = b.epoch;
      const generation = b.bindingRevision;
      const serial = b.serial;
      if (typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch < 0 ||
          typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 0 ||
          typeof serial !== 'number' || !Number.isSafeInteger(serial) || serial < 1)
        throw new ApiError('INVALID_INPUT', 'Exact transition fence required.');
      this.db.transaction(() => {
        const prior = this.db.get<TransitionFence | undefined>('binding-transition/v2');
        if (prior && (prior.serial > serial || (prior.serial === serial &&
            (prior.id !== transitionId || prior.epoch !== epoch || prior.bindingRevision !== generation || (prior.aborted && b.abort !== true)))))
          throw new ApiError('TRANSITION_BLOCKED', 'A newer or different Workspace fence exists.', 409);
        if (!prior || prior.serial < serial)
          this.db.put('binding-transition/v2', { id: transitionId, bindingRevision: generation, epoch, serial });
      });
      this.db.transaction(() => {
        if (this.journal.leaseBlocked() || this.journal.holds() || this.journal.running())
          throw new ApiError('TRANSITION_BLOCKED', 'Workspace has an unsettled dispatch or held effect.', 409);
        for (let i = 0; i < 8; i++) {
          const queued = this.journal.nextAdmitted();
          if (!queued) break;
          if (queued.dispatchAttempt)
            throw new ApiError('TRANSITION_BLOCKED', 'Dispatch outcome requires reconciliation.', 409);
          this.cancelUndispatched(queued, 'Workspace transition cancelled the undispatched operation.');
        }
      });
      await this.drainTerminalOutbox();
      if (this.journal.pendingExists() || this.journal.leaseBlocked() || this.journal.activeStats().length !== 0)
        throw new ApiError('TRANSITION_BLOCKED', 'Workspace has an unacknowledged terminal receipt or active operation.', 409);
      if (b.abort === true) this.db.transaction(() => {
        const fence = this.db.get<TransitionFence>('binding-transition/v2');
        if (fence?.id !== transitionId || fence.serial !== serial)
          throw new ApiError('TRANSITION_BLOCKED', 'Workspace fence changed before cancellation.', 409);
        this.db.put('binding-transition/v2', { ...fence, aborted: true });
      });
      maintenance.settled = true;
      return json({ settled: true });
    }
    if (path === "/internal/admit") {
      if(this.operations.blocked)throw new ApiError("GATEWAY_DEGRADED", "Operation migration is blocked; inspect storage-migration status and repair the recorded fixture before resuming.",503);
      const w = b.workspace as WorkspaceRecord,
        l = this.db.get<Lease>("lease");
      const tool = str(b.tool, "tool", 100), args = b.args as Record<string, unknown>;
      if (!args || typeof args !== "object" || Array.isArray(args))
        throw new ApiError("INVALID_INPUT", "Tool arguments required.");
      const props = b.props as AuthProps;
      let target: string | undefined, operationKey: string | undefined, scope: string | undefined;
      let requestDigest: string | undefined;
      let keys: OperationKeys | undefined;
      const replay = () => {
        if (!keys || !scope || !operationKey) return undefined;
        const found = keys.get(scope, operationKey);
        if (!found) return undefined;
        if (found.digest !== requestDigest)
          throw new ApiError('IDEMPOTENCY_CONFLICT', 'Operation key was used for a different request.', 409);
        const retained = this.operations.get('operation/' + found.operationId);
        if (!retained) return {contractVersion: 2, target, operationKey, operationId: found.operationId,
          serverTimeMs: Date.now(), phase: 'UNKNOWN', effectState: 'UNKNOWN', resultAvailability: 'EXPIRED',
          error: {code: 'RESULT_EXPIRED', message: 'Operation receipt retention expired. Do not replay the intent.'}};
        return this.summary(retained);
      };
      if (w.contractVersion === 2) {
        if (!w.binding || w.assignmentGeneration === undefined || w.bindingGeneration === undefined ||
            props.contractVersion !== 2)
          throw new ApiError('UPGRADE_REQUIRED', 'Matching v2 Grant required.', 409);
        target = encodeTarget({workspaceId: w.id, assignmentGeneration: w.assignmentGeneration, bindingGeneration: w.bindingGeneration});
        if (b.target !== target || w.connectorId !== b.agentId)
          throw new ApiError('STALE_TARGET', 'V2 admission lost its authorized Target.', 409);
        const selected = operationKeySchema.safeParse(b.operationKey);
        if (!selected.success) throw new ApiError('INVALID_INPUT', 'Canonical v2 operationKey required.');
        operationKey = selected.data;
        scope = keyScope(String(b.agentId), props.grantId, target);
        requestDigest = await digest(canonical([tool, args]));
        keys = this.operationKeys();
        const existing = replay();
        if (existing) {
          if (await rpc(registry(this.env), '/internal/authorize', {
            props, agentId: b.agentId, target, permissions: b.requiredPermissions, resultAccess: true,
          })) return json(existing);
        }
        await rpc(registry(this.env), '/internal/authorize', {
          props, agentId: b.agentId, target, permissions: b.requiredPermissions, mutating:b.mutating, tool,
        });
        if (l?.contractVersion !== 2 || l.assignmentGeneration !== w.assignmentGeneration ||
            l.bindingGeneration !== w.bindingGeneration)
          throw new ApiError('TAB_OFFLINE', 'A matching adapter lease is unavailable.', 503);
      } else if (props.contractVersion !== undefined || b.target !== undefined) {
        throw new ApiError('UPGRADE_REQUIRED', 'V2 admission requires an assigned Workspace.', 409);
      }
      if (!l || l.expiresAt <= Date.now() || l.epoch !== w.epoch || l.bindingRevision !== w.bindingRevision)
        throw new ApiError("TAB_OFFLINE", "Assigned editor is offline.", 503);
      const op: Operation = {
        operationId: crypto.randomUUID(),
        ...(target ? { target, operationKey, policyRevision: Number(b.policyRevision),
          permissionRevision: w.permissionRevision ?? 1 } : {}),
        sequence: 0,
        argsDigest: await digest(canonical(args)),
        workspaceId: w.id,
        epoch: l.epoch,
        bindingRevision: w.bindingRevision,
        tabInstanceId: l.tabInstanceId,
        deadlineMs: Date.now() + operationTimeoutMs(tool, args),
        tool,
        args,
        permissions: b.permissions as string[],
        requiredPermissions: b.requiredPermissions as string[],
        mutating: b.mutating === true,
        props,
        agentId: String(b.agentId),
        traceId: crypto.randomUUID(),
        phase: "ADMITTED",
        createdAt: Date.now(),
      };
      const admission = this.db.transaction(() => {
        const existing = replay();
        if (existing) return {existing} as const;
        // Argument hashing yields. The initially observed lease cannot authorize
        // a commit after release, expiry, or a replacement document's claim.
        const current = this.db.get<Lease>("lease");
        if (!current || current.expiresAt <= Date.now() || current.workspaceId !== l.workspaceId ||
            current.epoch !== l.epoch || current.bindingRevision !== l.bindingRevision ||
            current.tabInstanceId !== l.tabInstanceId || current.secretHash !== l.secretHash)
          throw new ApiError("STALE_EPOCH", "Lease changed during admission.", 409);
        const fence = this.env.DEVELOPMENT_CONTRACT_V2_ENABLED === 'true' ? this.db.get<TransitionFence>('binding-transition/v2') : undefined;
        if (fence && !fence.aborted && fence.bindingRevision === w.bindingRevision)
          throw new ApiError('TRANSITION_BLOCKED', 'Workspace is fenced for a Binding change.', 409);
        const all = this.journal.activeStats();
        if (this.journal.pendingFull())
          throw new ApiError(
            "QUOTA_EXCEEDED",
            "Terminal notice outbox is full; restore Registry communication before new work.",
            429,
          );
        if (
          this.journal.holdsFull()
        )
          throw new ApiError(
            "QUOTA_EXCEEDED",
            "Unresolved-operation metadata budget reached; reconcile held operations.",
            429,
          );
        if (op.mutating && this.journal.holds())
          throw new ApiError(
            "EFFECT_UNKNOWN",
            "Workspace holds an unresolved effect.",
            409,
          );
        if (all.length >= 8)
          throw new ApiError(
            "QUEUE_FULL",
            "Workspace queue has eight operations.",
            429,
          );
        if (
          all.reduce((n,o)=>n+o.argSize,0) +
            JSON.stringify(args).length >
          2 * 1024 * 1024
        )
          throw new ApiError(
            "QUOTA_EXCEEDED",
            "Workspace queue byte budget exhausted.",
            429,
          );
        const budget=reserveAdmission(this.db,admissionBudgetPolicy(this.env),op,()=>this.operations.budgetObligations(),Date.now(),()=>this.retainedCleanupSummary());
        if(budget)op.budgetReservation=budget.reservation;
        op.sequence = this.db.get<number>("sequence", 0) + 1;
        this.db.put("sequence", op.sequence);
        if (keys && scope && operationKey && requestDigest)
          keys.add(scope, operationKey, requestDigest, op.operationId, op.createdAt);
        this.operations.put("operation/" + op.operationId, op);
        return {committedLease: current} as const;
      });
      if ('existing' in admission) {
        await rpc(registry(this.env), '/internal/authorize', {
          props, agentId: b.agentId, target, permissions: b.requiredPermissions, resultAccess: true,
        });
        return json(admission.existing);
      }
      // No await separates the transaction's current lease from this hint.
      try{this.push.notify(admission.committedLease);}catch{ /* A missed hint is recovered by authoritative heartbeat. */ }
      return json(this.summary(op));
    }
    if (path === "/internal/status" || path === "/internal/cancel") {
      let operationId: string;
      if (b.operationId === undefined && typeof b.operationKey === 'string') {
        const props = b.props as AuthProps | undefined;
        if (typeof b.agentId !== 'string' || typeof b.target !== 'string' || props?.contractVersion !== 2)
          throw new ApiError('NOT_FOUND', 'Operation not found in this scope.', 404);
        const found = this.operationKeys().get(keyScope(b.agentId, props.grantId, b.target), b.operationKey);
        if (!found) throw new ApiError('NOT_FOUND', 'Operation key was not retained for this scope.', 404);
        operationId = id(found.operationId);
      } else {
        operationId = id(b.operationId);
      }
      let op = this.operations.get("operation/" + operationId);
      if (
        !op ||
        op.workspaceId !== b.workspaceId ||
        (op.target && typeof b.agentId === 'string' && b.target !== op.target) ||
        (!op.target && b.target !== undefined) ||
        (b.bindingRevision !== undefined &&
          op.bindingRevision !== b.bindingRevision) ||
        (b.agentId !== undefined && op.agentId !== b.agentId)
      )
        throw new ApiError(
          "NOT_FOUND",
          "Operation not found in this Workspace.",
          404,
        );
      const scoped = !!op.target && typeof b.agentId === 'string';
      if (scoped) {
        await this.authorizeScopedResult(op, b);
        const current = this.operations.get('operation/' + operationId);
        if (!current || current.props.grantId !== op.props.grantId || current.target !== op.target)
          throw new ApiError('NOT_FOUND', 'Operation not found in this scope.', 404);
        op = current;
      }
      const authorizedOperation = op;
      // Ordinary status has no history maintenance dependency. Only this
      // operation's exact deadline/result TTL may change its canonical state.
      if (this.db.transaction(() => this.expireOperation(authorizedOperation, Date.now())))
        throw new ApiError("NOT_FOUND", "Operation retention expired.", 404);
      if (path === "/internal/cancel") {
        if (op.phase === "ADMITTED" && (!scoped || !op.dispatchAttempt)) {
          this.db.transaction(() => this.cancelUndispatched(authorizedOperation, 'Queued operation cancelled before dispatch.'));
        } else if (!op.terminalAt && scoped) {
          op.cancelRequested = true;
          this.operations.put('operation/' + operationId, op);
        } else if (!op.terminalAt)
          throw new ApiError(
            "EFFECT_UNKNOWN",
            "Dispatched operation cannot be claimed cancelled. Reconcile its result.",
            409,
          );
      }
      const summary = this.summary(op);
      // A pending receipt still gets the normal durable retry path. Clean
      // active/already-notified status reads do not enumerate outbox/history.
      maintenance.settled = !op.terminalAt || op.terminalNotified === true;
      let data: unknown = summary;
      if (path === '/internal/status' && typeof b.agentId === 'string' && typeof b.bindingRevision === 'number') {
        try {
          data = await this.images.hydrate(summary, {workspaceId: op.workspaceId, operationId,
            agentId: b.agentId, bindingRevision: b.bindingRevision});
        } catch (error) {
          if (!scoped) throw error;
          const code = error instanceof ApiError ? error.code : undefined;
          data = omitDevelopmentResult(summary,
            code === 'RESULT_EXPIRED' ? 'EXPIRED' : code === 'LIMIT_EXCEEDED' ? 'TOO_LARGE' : 'UNAVAILABLE');
        }
      }
      if (scoped) await this.authorizeScopedResult(op, b);
      return json(data);
    }
    // Admin-only read-only diagnostic path. Exposed by the top-level Worker
    // only after its regular Registry admin authentication succeeds. Never
    // disclose lease secrets, request arguments, provider content or tokens.
    if (path === "/internal/recovery") {
      const workspaceId = id(b.workspaceId);
      const current = this.db.get<Lease>("lease");
      const now = Date.now();
      const active = current && current.workspaceId === workspaceId && current.expiresAt > now
        ? {epoch:current.epoch,bindingRevision:current.bindingRevision,expiresAt:current.expiresAt}
        : null;
      const claiming = this.db.get<{expiresAt:number}>("claiming");
      const pendingClaimUntil = claiming && claiming.expiresAt > now ? claiming.expiresAt : null;
      const operations = (this.operations.journalReady?this.journal.leaseBlockers():[])
        .filter(op=>op.workspaceId === workspaceId)
        .sort((a,z)=>a.createdAt-z.createdAt)
        .slice(0,128)
        .map(op=>({
          operationId:op.operationId,tool:op.tool,phase:op.phase,
          epoch:op.epoch,bindingRevision:op.bindingRevision,
          createdAt:op.createdAt,deadlineMs:op.deadlineMs,
          terminalAt:op.terminalAt??null,
          resolvable: ['UNKNOWN','PARTIAL'].includes(op.phase) && !op.resolution,
        }));
      let budget:ReturnType<typeof admissionBudgetSnapshot>;
      try{budget=admissionBudgetSnapshot(this.db,admissionBudgetPolicy(this.env));}
      catch{budget={enabled:this.env.ADMISSION_BUDGET_ENABLED==="true",known:false,scope:"workspace",reason:"ACCOUNTING_UNAVAILABLE"};}
      return json({schemaVersion:1,workspaceId,observedAt:now,admissionBudget:budget,
        activeLease:active,pendingClaimUntil,blockingOperations:operations,
        storageMigration:this.operations.progress(),storagePreparing:!this.operations.journalReady,
        blockingOperationsKnown:this.operations.journalReady,
        leaseClaimAvailable:this.operations.journalReady&&!active&&!pendingClaimUntil&&!operations.length,
        action: !this.operations.journalReady ? 'WAIT_FOR_STORAGE' : operations.some(op=>op.resolvable) ? 'RECONCILE' :
          operations.length ? 'WAIT_FOR_TERMINAL' :
          active||pendingClaimUntil ? 'WAIT_FOR_LEASE' : 'RECONNECT',
      });
    }
    if (path === "/api/v1/tab/claim") {
      const workspaceId = id(b.workspaceId),
        tabInstanceId = id(b.tabInstanceId),
        credential = bearer(request);
      if (b.adapterVersion !== "1" && b.adapterVersion !== "2")
        throw new ApiError("INCOMPATIBLE_VERSION", "Unsupported adapter protocol version.", 409);
      // Authenticate installation and binding before writing a claim guard or
      // running expiry. Recheck local ownership after the asynchronous RPC.
      const approved = await rpc<{
        workspace: WorkspaceRecord;
        credentialEpoch: number;
      }>(registry(this.env), "/internal/claim", {
        workspaceId,
        binding: b.binding,
        credential,
        adapterVersion: b.adapterVersion,
      });
      const guard = crypto.randomUUID();
      this.db.transaction(() => {
        this.expire();
        const current = this.db.get<Lease>("lease");
        if(this.journal.leaseBlocked())
          throw new ApiError("EFFECT_UNKNOWN","Previous document has an unresolved operation. Reconciliation required before reconnect.",409);
        if (current && current.expiresAt > Date.now()) {
          if (approved.workspace.contractVersion !== 2 || current.bindingRevision >= approved.workspace.bindingRevision)
            throw new ApiError("TAB_BUSY","Another document has an active lease.",409);
          this.db.put('retired/' + current.epoch + '/' + current.tabInstanceId, current);
          this.db.delete('lease');
        }
        const claiming = this.db.get<{ expiresAt: number }>("claiming");
        if(claiming&&claiming.expiresAt>Date.now())
          throw new ApiError("TAB_BUSY","Lease claim already in progress.",409);
        this.db.put("claiming",{guard,expiresAt:Date.now()+30000});
      });
      try {
        const fresh = await rpc<{ epoch: number }>(
          registry(this.env),
          "/internal/epoch",
          { workspaceId, expectedEpoch: approved.workspace.epoch,
            expectedBindingRevision: approved.workspace.bindingRevision },
        );
        const secret = randomSecret(),
          secretHash = await digest(secret);
        const l: Lease = {
          workspaceId,
          ...(approved.workspace.contractVersion === 2 ? {
            contractVersion: 2, assignmentGeneration: approved.workspace.assignmentGeneration,
            bindingGeneration: approved.workspace.bindingGeneration,
          } : {}),
          epoch: fresh.epoch,
          bindingRevision: approved.workspace.bindingRevision,
          tabInstanceId,
          secretHash,
          claimedAt: Date.now(),
          expiresAt: Date.now() + 180000,
          credentialEpoch: approved.credentialEpoch,
          permissions: approved.workspace.permissions,
        };
        this.db.transaction(() => {
          const claim=this.db.get<{guard:string;expiresAt:number}>("claiming");
          if(claim?.guard!==guard||claim.expiresAt<=Date.now())
            throw new ApiError("STALE_EPOCH","Claim was superseded or expired.",409);
          this.db.put("lease", l);
          this.db.delete("claiming");
        });
        this.push.close();
        return json({
          workspaceId,
          ...(l.contractVersion === 2 ? { contractVersion: 2,
            connectorId: approved.workspace.connectorId, assignmentGeneration: l.assignmentGeneration,
            bindingGeneration: l.bindingGeneration, installationId: approved.workspace.binding?.browserInstallationId,
            generatorId: approved.workspace.binding?.generatorId, draftId: approved.workspace.binding?.draftId,
          } : {}),
          ...(this.push.enabled?{notifications:{version:1}}:{}),
          epoch: l.epoch,
          bindingRevision: l.bindingRevision,
          tabInstanceId,
          leaseCredential: secret,
          expiresAt: l.expiresAt,
          permissions: l.permissions,
        });
      } catch (error) {
        this.db.transaction(()=>{
          if(this.db.get<{guard:string}>("claiming")?.guard===guard)this.db.delete("claiming");
        });
        throw error;
      }
    }
    if (path === "/internal/resolve") {
      const op = this.operations.get("operation/" + id(b.operationId));
      if (
        !op ||
        op.workspaceId !== b.workspaceId ||
        op.epoch !== b.epoch ||
        op.bindingRevision !== b.bindingRevision ||
        !["UNKNOWN", "PARTIAL"].includes(op.phase)
      )
        throw new ApiError(
          "APPROVAL_REQUIRED",
          "Exact unresolved operation, epoch and binding required.",
          409,
        );
      if (!op.resolution) {
        op.resolution = b.resolution;
        this.operations.put("operation/" + op.operationId, op);
        const current = this.db.get<Lease>("lease");
        if (current) {
          this.db.put(
            "retired/" + current.epoch + "/" + current.tabInstanceId,
            current,
          );
          this.db.delete("lease");
          this.push.close();
        }
      }
      return json(this.summary(op));
    }
    // Hash asynchronously before reading and validating the current lease.
    // There is no asynchronous gap between the validated read and poll renewal.
    const l = this.lease(
      await digest(bearer(request)),
      b,
      path === "/api/v1/tab/reply" && b.phase !== "RUNNING",
    );
    if(path==="/api/v1/tab/ticket"){maintenance.settled=true;return json(await this.push.issue(l));}
    if (path !== "/api/v1/tab/poll") this.expire();
    if (path === "/api/v1/tab/image")
      return json(await this.images.handle(b, l));
    if (path === "/api/v1/tab/music" || path === "/api/v1/tab/music-result")
      return json(await this.music.handle(path, b, l));
    if (path === "/api/v1/tab/release") {
      this.db.put("retired/" + l.epoch + "/" + l.tabInstanceId, l);
      this.db.delete("lease");
      this.push.close();
      return json({ ok: true });
    }
    if (path === "/api/v1/tab/heartbeat") {
      let valid:{permissions:string[]};
      try {valid = await rpc<{ permissions: string[] }>(
        registry(this.env),
        "/internal/lease-check",
        {
          workspaceId: l.workspaceId,
          epoch: l.epoch,
          bindingRevision: l.bindingRevision,
          credentialEpoch: l.credentialEpoch,
          ...(l.contractVersion === 2 ? { adapterVersion: '2', dirty: b.dirty } : {}),
        },
      );}catch(error){
        const active=this.db.get<Lease>("lease");
        if(active&&active.epoch===l.epoch&&active.bindingRevision===l.bindingRevision&&active.tabInstanceId===l.tabInstanceId&&active.secretHash===l.secretHash)this.push.close();
        throw error;
      }
      const current = this.db.get<Lease>("lease");
      if (
        !current ||
        current.epoch !== l.epoch ||
        current.tabInstanceId !== l.tabInstanceId || current.bindingRevision !== l.bindingRevision ||
        current.secretHash !== l.secretHash || current.expiresAt <= Date.now()
      )
        throw new ApiError("STALE_EPOCH", "Lease changed during renewal.", 409);
      const permissionsChanged = canonical(current.permissions) !== canonical(valid.permissions);
      const renewalDue = current.expiresAt - Date.now() <= 120000;
      if (renewalDue) current.expiresAt = Date.now() + 180000;
      current.permissions = valid.permissions;
      if (renewalDue || permissionsChanged) this.db.put("lease", current);
      const controlled = current.contractVersion === 2 && typeof b.activeOperationId === 'string'
        ? this.operations.get('operation/' + id(b.activeOperationId)) : undefined;
      const cancellation = controlled?.cancelRequested === true && controlled.target &&
        ['DISPATCHED', 'RUNNING'].includes(controlled.phase) && controlled.workspaceId === current.workspaceId &&
        controlled.epoch === current.epoch && controlled.bindingRevision === current.bindingRevision &&
        controlled.tabInstanceId === current.tabInstanceId && controlled.target === encodeTarget({
          workspaceId: current.workspaceId, assignmentGeneration: current.assignmentGeneration!,
          bindingGeneration: current.bindingGeneration!,
        });
      return json({
        expiresAt: current.expiresAt,
        permissions: current.permissions,
        ...(cancellation ? {cancelRequestedOperationId: controlled.operationId} : {}),
        ...(this.push.enabled?{workAvailable:this.journal.workAvailable()}:{}),
      });
    }
    if (path === "/api/v1/tab/poll") {
      const fence = l.contractVersion === 2 ? this.db.get<TransitionFence>('binding-transition/v2') : undefined;
      if (fence && !fence.aborted && fence.bindingRevision === l.bindingRevision)
        return json({ operations: [], expiresAt: l.expiresAt, idleWaitMs: 5000 });
      if(!this.operations.journalReady)throw new ApiError("GATEWAY_DEGRADED","Operation storage migration is preparing its counter authority. Preserve pending browser results and retry after migration.",503);
      // Recheck registry policy through an execution credential-independent lease revision probe at dispatch.
      // Never sleep inside a Durable Object. The outer Worker paces empty responses.
      const refreshed = l;
      if (l.expiresAt - Date.now() <= 120000 || !refreshed.claimedAt) {
        refreshed.claimedAt ??= Date.now();
        refreshed.expiresAt = l.expiresAt = Date.now() + 180000;
        this.db.put("lease", refreshed);
      }
      const idle=await this.idlePollState();
      if(idle){
        // No work was eligible at the snapshot. A concurrent admission is
        // independently persisted and observed by the next ordinary poll.
        maintenance.settled=true;
        const idleFor=Date.now()-Math.max(refreshed.claimedAt??Date.now(),idle.lastActivityAt);
        return json({operations:[],expiresAt:l.expiresAt,idleWaitMs:idleFor>=120000?15000:5000});
      }
      this.expire();
      if(this.journal.running())return json({operations:[],expiresAt:l.expiresAt,idleWaitMs:5000});
      const op=this.journal.nextAdmitted();
      if(!op){
        const idleFor=Date.now()-Math.max(refreshed.claimedAt??Date.now(),this.journal.lastActivityAt());
        return json({operations:[],expiresAt:l.expiresAt,idleWaitMs:idleFor>=120000?15000:5000});
      }
      if(op.dispatchAttempt)return json({operations:[],expiresAt:l.expiresAt,idleWaitMs:5000});
      const attempt={id:crypto.randomUUID(),reconcileAt:Date.now()+5000};
      this.db.transaction(()=>{
        const fresh=this.operations.get("operation/"+op.operationId);
        if(!fresh||fresh.phase!=="ADMITTED"||fresh.dispatchAttempt)
          throw new ApiError("CONFLICT","Operation dispatch is already in progress.",409);
        fresh.dispatchAttempt=attempt;
        this.operations.put("operation/"+fresh.operationId,fresh);
      });
      let dispatchPermissions=op.permissions;
      try {
        // Persisted recovery precedes permit consumption. A crash after the
        // permit RPC can never turn this ADMITTED row into a replayable intent.
        await this.scheduleAlarm();
        const before=this.operations.get("operation/"+op.operationId),lease=this.db.get<Lease>("lease");
        if(!before||before.phase!=="ADMITTED"||before.dispatchAttempt?.id!==attempt.id||
            !lease||lease.expiresAt<=Date.now()||lease.epoch!==op.epoch||lease.tabInstanceId!==op.tabInstanceId||lease.secretHash!==l.secretHash)
          throw new ApiError("STALE_EPOCH","Dispatch was cancelled or its lease changed.",409);
        const authority=await rpc<{workspace:{permissions:string[]};grant:{permissions:string[]}}>(registry(this.env), "/internal/dispatch", {
          props: op.props,
          agentId: op.agentId,
          ...(op.target ? { target: op.target } : {}),
          permissions: op.requiredPermissions,
          mutating: op.mutating,
          workspaceId: l.workspaceId,
          bindingRevision: l.bindingRevision,
          epoch: l.epoch,
          operationId: op.operationId,
          tool: op.tool,
        });
        if(!Array.isArray(authority.workspace?.permissions)||!Array.isArray(authority.grant?.permissions))
          throw new ApiError("GATEWAY_DEGRADED","Registry dispatch authority has an invalid shape.",503);
        dispatchPermissions=op.permissions.filter(p=>authority.workspace.permissions.includes(p)&&authority.grant.permissions.includes(p));
      } catch (error) {
        this.db.transaction(() => {
          const current = this.operations.get("operation/" + op.operationId);
          // A second poll, deadline, cancel, or terminal reply may have won
          // while Registry authorization was in flight. Never overwrite it.
          if (!current || current.phase !== "ADMITTED" || current.epoch !== op.epoch ||
              current.tabInstanceId !== op.tabInstanceId || current.bindingRevision !== op.bindingRevision || current.dispatchAttempt?.id!==attempt.id) return;
          const knownRejection=error instanceof ApiError&&error.status>=400&&error.status<500;
          current.phase = knownRejection ? "REJECTED" : "UNKNOWN";
          current.terminalAt = Date.now();
          current.terminalErrorCode=current.phase==="UNKNOWN"?"EFFECT_UNKNOWN":error instanceof ApiError?error.code:"REVOKED";
          current.result = {operationId:current.operationId,status:current.phase,effectState:current.phase==="UNKNOWN"?"POSSIBLE":"NONE",error:{
            code:current.terminalErrorCode,message:current.phase==="UNKNOWN"?"Dispatch authority outcome requires reconciliation.":"Dispatch rejected after authorization changed.",
            retryable:false,recovery:"Inspect the exact operation; do not replay an uncertain dispatch.",
          }};
          current.terminalResultDigest=operationReceiptDigest(current.result);
          delete current.args;
          this.operations.put("operation/" + current.operationId, current);
        });
        return json({ operations: [], expiresAt: l.expiresAt });
      }
      // The permit RPC yields. Commit against fresh canonical phase, lease,
      // binding and deadline in one synchronous transaction before exposure.
      const dispatched = this.db.transaction(() => {
        const active = this.db.get<Lease>("lease");
        const fresh = this.operations.get("operation/" + op.operationId);
        if (!active || active.expiresAt <= Date.now() || active.epoch !== op.epoch ||
            active.bindingRevision !== op.bindingRevision || active.tabInstanceId !== op.tabInstanceId ||
            active.secretHash !== l.secretHash)
          throw new ApiError("STALE_EPOCH", "Lease changed before dispatch.", 409);
        if (!fresh || fresh.phase !== "ADMITTED" || fresh.epoch !== op.epoch ||
            fresh.bindingRevision !== op.bindingRevision || fresh.tabInstanceId !== op.tabInstanceId || fresh.dispatchAttempt?.id!==attempt.id)
          throw new ApiError("CONFLICT", "Operation already consumed.", 409);
        if (fresh.cancelRequested) {
          delete fresh.dispatchAttempt;
          this.cancelUndispatched(fresh,'Operation was cancelled before the browser received dispatch.');
          return;
        }
        if (fresh.deadlineMs <= Date.now() || attempt.reconcileAt<=Date.now()) {
          this.expireOperation(fresh, Date.now());
          return;
        }
        fresh.phase = "DISPATCHED";
        fresh.permissions=dispatchPermissions;
        delete fresh.dispatchAttempt;
        this.operations.put("operation/" + fresh.operationId, fresh);
        return fresh;
      });
      if (!dispatched || dispatched.phase !== "DISPATCHED")
        return json({ operations: [], expiresAt: l.expiresAt });
      return json({
        operations: [
          {
            ...(dispatched.target ? {
              version: 2, target: dispatched.target, operationKey: dispatched.operationKey,
              connectorId: dispatched.agentId, grantId: dispatched.props.grantId,
              assignmentGeneration: l.assignmentGeneration, bindingGeneration: l.bindingGeneration,
              policyRevision: dispatched.policyRevision, permissionRevision: dispatched.permissionRevision,
            } : {version: 1}),
            operationId: dispatched.operationId,
            workspaceId: dispatched.workspaceId,
            epoch: dispatched.epoch,
            bindingRevision: dispatched.bindingRevision,
            tabInstanceId: dispatched.tabInstanceId,
            deadlineMs: dispatched.deadlineMs,
            tool: dispatched.tool,
            args: dispatched.args,
            traceId: dispatched.traceId,
            permissions: dispatched.permissions,
          },
        ],
        expiresAt: l.expiresAt,
      });
    }
    if (path === '/api/v1/tab/segment') {
      const op = this.operations.get('operation/' + id(b.operationId));
      if (!op?.target || op.phase !== 'RUNNING' || op.epoch !== l.epoch || op.tabInstanceId !== l.tabInstanceId ||
          op.deadlineMs <= Date.now() || op.cancelRequested)
        throw new ApiError('CANCELLED', 'V2 operation is ended, cancelled or fenced.', 409);
      const parsed = segmentRequestSchema.safeParse(b.segment);
      if (!parsed.success) throw new ApiError('INVALID_INPUT', 'Exact bounded segment required.');
      const segment = parsed.data;
      const granted = await rpc(registry(this.env), '/internal/v2/segment', {
        props: op.props, agentId: op.agentId, target: op.target, workspaceId: l.workspaceId,
        epoch: l.epoch, bindingRevision: l.bindingRevision, operationId: op.operationId,
        permissions: op.requiredPermissions, mutating: op.mutating, tool: op.tool, segment,
      });
      const latest = this.operations.get('operation/' + op.operationId);
      const active = this.db.get<Lease>('lease');
      if (latest?.phase !== 'RUNNING' || latest.cancelRequested || !active ||
          active.epoch !== l.epoch || active.secretHash !== l.secretHash ||
          active.expiresAt <= Date.now() || op.deadlineMs <= Date.now())
        throw new ApiError('CANCELLED', 'Operation authority changed before segment delivery.', 409);
      return json(granted);
    }
    if (path === "/api/v1/tab/permit") {
      const op = this.operations.get("operation/" + id(b.operationId));
      if (
        !op ||
        op.phase !== "RUNNING" ||
        op.epoch !== l.epoch ||
        op.tabInstanceId !== l.tabInstanceId
      )
        throw new ApiError(
          "STALE_EPOCH",
          "Child operation requires a running parent in this lease.",
          409,
        );
      if (op.target)
        throw new ApiError('SCOPE_DENIED', 'V2 operations cannot use the legacy child-tool broker.', 403);
      const allowed = [
        op.tool,
        "put_files",
        "glob",
        "grep",
        "edit",
        "patch",
        "read",
        "write",
        "read_b64_file",
        "save_b64_file",
        "list_files",
        "rename_file",
        "delete_file",
        "page_eval",
        "page_refresh",
        "fetch_url",
        "generate_image",
        "upload_file",
        "set_viewport_size",
      ];
      const tool = String(b.tool);
      if (!allowed.includes(tool))
        throw new ApiError(
          "SCOPE_DENIED",
          "Child tool is not allowlisted.",
          403,
        );
      const args = validateToolCall(tool, b.args);
      const definition = toolDefinitions.find((d) => d.name === tool)!;
      const needed: string[] = permissionsForTool(tool, args);
      if (!needed.every((p) => op.permissions.includes(p)))
        throw new ApiError(
          "SCOPE_DENIED",
          "Child tool exceeds parent Grant.",
          403,
        );
      const fresh = await rpc<{
        workspace: WorkspaceRecord;
        grant: { permissions: string[] };
      }>(registry(this.env), "/internal/authorize", {
        props: op.props,
        agentId: op.agentId,
        permissions: needed,
        mutating: definition.mutating,
        tool,
      });
      if (
        fresh.workspace.epoch !== op.epoch ||
        fresh.workspace.bindingRevision !== op.bindingRevision
      )
        throw new ApiError(
          "STALE_EPOCH",
          "Binding changed during parent execution.",
          409,
        );
      const current = this.operations.get("operation/" + op.operationId);
      const currentLease = this.db.get<Lease>("lease");
      if (!current || current.phase !== "RUNNING" || current.deadlineMs <= Date.now() ||
          current.epoch !== op.epoch || current.bindingRevision !== op.bindingRevision ||
          current.tabInstanceId !== op.tabInstanceId || !currentLease || currentLease.expiresAt <= Date.now() ||
          currentLease.epoch !== l.epoch || currentLease.bindingRevision !== l.bindingRevision ||
          currentLease.tabInstanceId !== l.tabInstanceId || currentLease.secretHash !== l.secretHash)
        throw new ApiError("STALE_EPOCH", "Parent or lease changed during child authorization.", 409);
      return json({
        permissions: current.permissions.filter(
          (p) =>
            fresh.workspace.permissions.includes(p) &&
            fresh.grant.permissions.includes(p),
        ),
      });
    }
    if (path === "/api/v1/tab/reply") {
      const operationId = id(b.operationId),
        phase = String(b.phase);
      if (
        ![
          "RUNNING",
          "SUCCEEDED",
          "REJECTED",
          "UNKNOWN",
          "PARTIAL",
          "CANCELLED",
        ].includes(phase)
      )
        throw new ApiError("INVALID_INPUT", "Invalid operation phase.");
      if (phase !== "RUNNING") {
        const parsed = toolResultSchema.safeParse(b.result);
        if (
          !parsed.success ||
          parsed.data.operationId !== b.operationId ||
          parsed.data.status !== phase
        )
          throw new ApiError(
            "INVALID_INPUT",
            "Terminal result must match operation and phase.",
          );
      }
      this.db.transaction(() => {
        const op = this.operations.get("operation/" + operationId);
        if (!op || op.epoch !== l.epoch || op.tabInstanceId !== l.tabInstanceId)
          throw new ApiError(
            "STALE_EPOCH",
            "Operation belongs to another lease.",
            409,
          );
        if (op.terminalAt) {
          if (op.phase === "UNKNOWN" && phase !== "RUNNING") {
            op.lateObservation = b.result;
            this.operations.put("operation/" + operationId, op);
            return;
          }
          if (
            op.phase === phase &&
            (canonical(op.result) === canonical(b.result) ||
              (op.terminalResultDigest ?? this.operations.receiptDigest("operation/"+operationId)) === operationReceiptDigest(b.result))
          )
            return;
          throw new ApiError(
            "CONFLICT",
            "Terminal operation cannot be rewritten.",
            409,
          );
        }
        if (!["DISPATCHED", "RUNNING"].includes(op.phase))
          throw new ApiError("CONFLICT", "Operation not dispatched.", 409);
        // Scoped controllers can attest a known pre-effect stop. The parsed
        // terminal receipt already requires effectState NONE for CANCELLED.
        if (!op.target && phase === "CANCELLED" && op.phase === "RUNNING" && op.mutating)
          throw new ApiError(
            "EFFECT_UNKNOWN",
            "Running mutation cannot be reported cancelled.",
            409,
          );
        if (phase === "RUNNING" && op.phase === "RUNNING") return;
        op.phase = phase;
        if (op.target && phase === "SUCCEEDED") {
          const verifiedEffect = (b.result as {effectState: unknown}).effectState;
          if (verifiedEffect !== 'NONE' && verifiedEffect !== 'VERIFIED')
            throw new ApiError('INVALID_INPUT', 'A successful operation requires a verified effect state.');
          op.terminalEffectState = op.mutating && verifiedEffect === 'VERIFIED' ? 'KNOWN' : 'NONE';
        }
        if (phase !== "RUNNING") {
          op.terminalResultDigest=operationReceiptDigest(b.result);
          const errorCode=(b.result as {error?:{code?:unknown}})?.error?.code;
          if(typeof errorCode==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(errorCode))op.terminalErrorCode=errorCode;
          const retained = this.journal.stats().resultSize;
          op.result =
            retained + JSON.stringify(b.result).length <= 8 * 1024 * 1024
              ? b.result
              : undefined;
          op.terminalAt = Date.now();
          delete op.args;
        }
        this.operations.put("operation/" + operationId, op);
      });
      return json({ ok: true });
    }
    throw new ApiError("NOT_FOUND", "Route not found.", 404);
  }
}
