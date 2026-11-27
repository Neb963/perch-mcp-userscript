import { withSqlUsage } from "./sql-meter.js";
import { ImageTransferHandler } from "./image-transfer.js";
import { MusicHandler } from "./media/handler.js";
import type { DurableObjectState } from "@cloudflare/workers-types";
import {
  ApiError,
  bearer,
  canonical,
  digest,
  errorResponse,
  id,
  json,
  parseBody,
  operationTimeoutMs,
  randomSecret,
  registry,
  rpc,
  str,
  type Env,
} from "./common.js";
import { SqlRecords } from "./sql.js";
import { OperationIndex } from "./operation-index.js";
import { MaintenanceIndex } from "./maintenance-index.js";
import {
  toolDefinitions,
  validateToolCall,
  toolResultSchema,
  permissionsForTool,
} from "../../../packages/contracts/src/index.js";
import type { AuthProps, WorkspaceRecord } from "./registry.js";
import { isTerminalViewportEffect } from "../../../packages/contracts/src/effect-policy.js";
interface Lease {
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
  resolution?: unknown;
  lateObservation?: unknown;
}
export class Workspace {
  private db: SqlRecords;
  private journal: OperationIndex<Operation>;
  private maintenance: MaintenanceIndex;
  private music: MusicHandler;
  private images: ImageTransferHandler<Operation>;
  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {
    this.db = new SqlRecords(state.storage);
    const schema = this.db.get<number>("schema");
    if (schema !== undefined && schema !== 1)
      throw new ApiError(
        "INCOMPATIBLE_VERSION",
        "Workspace schema is newer than this Worker.",
        409,
      );
    if (schema === undefined) this.db.put("schema", 1);
    this.journal = new OperationIndex<Operation>(this.db);
    this.maintenance = new MaintenanceIndex(this.db);
    this.images = new ImageTransferHandler(this.db, {
      getLease: () => this.db.get<Lease>("lease"),
      getOperation: (operationId) =>
        this.db.get<Operation>("operation/" + operationId),
      authorize: async (op) => {
        const fresh = await rpc<{ workspace: WorkspaceRecord }>(
          registry(this.env),
          "/internal/authorize",
          {
            props: op.props,
            agentId: op.agentId,
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
    this.music = new MusicHandler(this.db, this.env, {
      getLease: () => this.db.get<Lease>("lease"),
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
    try {
      response = await this.route(request);
    } catch (error) {
      response = errorResponse(error);
    }
    // Invalid public requests must not amplify maintenance work. An alarm or
    // next authorized request drains any pending canonical terminal state.
    const path = new URL(request.url).pathname;
    if (path !== "/internal/sql-usage" && (response.ok || path.startsWith("/internal/"))) await this.drainTerminalOutbox();
    return response;
  }
  async alarm(): Promise<void> {
    return withSqlUsage(this.env.SQL_TELEMETRY_ENABLED==="true","workspace","alarm",async()=>{
      this.expire();
      await this.drainTerminalOutbox();
    });
  }
  private async scheduleAlarm(retryAt?: number): Promise<void> {
    const deadlines: number[] = [];
    const due = this.journal.nextDue();
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
  private async drainTerminalOutbox(): Promise<void> {
    let failed = false;
    const retryAt = this.journal.pendingExists() ? this.db.get<number>("outbox-retry-at", 0) : 0;
    if (retryAt > Date.now()) {
      // Ordinary traffic must not bypass a durable outage backoff.
      try { await this.scheduleAlarm(retryAt); } catch { /* Retain durable outbox. */ }
      return;
    }
    for (const {key} of this.journal.pendingKeys()) {
      const op=this.db.get<Operation>(key);
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
          const current = this.db.get<Operation>("operation/" + op.operationId);
          if (current && current.phase === op.phase) {
            current.terminalNotified = true;
            this.db.put("operation/" + current.operationId, current);
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
      for (const op of this.journal.due(now)) {
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
          this.db.put("operation/" + op.operationId, op);
        }
        if (
          ![
            "SUCCEEDED",
            "REJECTED",
            "UNKNOWN",
            "PARTIAL",
            "CANCELLED",
          ].includes(op.phase) &&
          op.deadlineMs <= now
        ) {
          op.phase = op.phase === "ADMITTED" ? "REJECTED" : "UNKNOWN";
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
          delete op.args;
          this.db.put("operation/" + op.operationId, op);
        } else if (
          op.terminalAt &&
          op.terminalAt + 600000 <= now &&
          op.result !== undefined
        ) {
          delete op.result;
          this.db.put("operation/" + op.operationId, op);
        }
        if (op.terminalAt && op.terminalNotified &&
            (!["UNKNOWN","PARTIAL"].includes(op.phase) || op.resolution || isTerminalViewportEffect(op)) &&
            op.createdAt + 7 * 86400000 <= now)
          this.db.delete("operation/" + op.operationId);
      }
      for (const {key} of this.journal.excessRetention()) this.db.delete(key);
    });
  }
  private async lease(
    request: Request,
    b: Record<string, unknown>,
    terminalOnly = false,
  ): Promise<Lease> {
    const hash = await digest(bearer(request));
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
  private summary(op: Operation): Record<string, unknown> {
    return {
      operationId: op.operationId,
      status: op.phase,
      workspaceId: op.workspaceId,
      tool: op.tool,
      createdAt: op.createdAt,
      argsDigest: op.argsDigest,
      epoch: op.epoch,
      bindingRevision: op.bindingRevision,
      ...(op.resolution ? { resolution: op.resolution } : {}),
      ...(op.lateObservation ? { lateObservation: op.lateObservation } : {}),
      ...(op.result === undefined || (op.terminalAt!==undefined&&op.terminalAt+600000<=Date.now())
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
  private async route(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname,
      b = await parseBody(request);
    if (path === "/internal/sql-usage") return json(this.db.snapshotUsage());
    if (path.startsWith("/internal/")) this.expire();
    if (path === "/internal/admit") {
      const w = b.workspace as WorkspaceRecord,
        l = this.db.get<Lease>("lease");
      if (!l || l.expiresAt <= Date.now() || l.epoch !== w.epoch)
        throw new ApiError("TAB_OFFLINE", "Assigned editor is offline.", 503);
      const tool = str(b.tool, "tool", 100),
        args = b.args as Record<string, unknown>;
      if (!args || typeof args !== "object" || Array.isArray(args))
        throw new ApiError("INVALID_INPUT", "Tool arguments required.");
      const op: Operation = {
        operationId: crypto.randomUUID(),
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
        props: b.props as AuthProps,
        agentId: String(b.agentId),
        traceId: crypto.randomUUID(),
        phase: "ADMITTED",
        createdAt: Date.now(),
      };
      this.db.transaction(() => {
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
        op.sequence = this.db.get<number>("sequence", 0) + 1;
        this.db.put("sequence", op.sequence);
        this.db.put("operation/" + op.operationId, op);
      });
      return json(this.summary(op));
    }
    if (path === "/internal/status" || path === "/internal/cancel") {
      const op = this.db.get<Operation>("operation/" + id(b.operationId));
      if (
        !op ||
        op.workspaceId !== b.workspaceId ||
        (b.bindingRevision !== undefined &&
          op.bindingRevision !== b.bindingRevision) ||
        (b.agentId !== undefined && op.agentId !== b.agentId)
      )
        throw new ApiError(
          "NOT_FOUND",
          "Operation not found in this Workspace.",
          404,
        );
      if (path === "/internal/cancel") {
        if (op.phase === "ADMITTED") {
          op.phase = "CANCELLED";
          op.result = {
            operationId: op.operationId,
            status: "CANCELLED",
            effectState: "NONE",
            error: {
              code: "CANCELLED",
              message: "Queued operation cancelled before dispatch.",
              retryable: false,
              recovery:
                "No effect occurred. Inspect current source before starting new work.",
            },
          };
          op.terminalAt = Date.now();
          delete op.args;
          this.db.put("operation/" + op.operationId, op);
        } else if (!op.terminalAt)
          throw new ApiError(
            "EFFECT_UNKNOWN",
            "Dispatched operation cannot be claimed cancelled. Reconcile its result.",
            409,
          );
      }
      const summary = this.summary(op);
      return json(
        path === "/internal/status" &&
          typeof b.agentId === "string" &&
          typeof b.bindingRevision === "number"
          ? await this.images.hydrate(summary, {
              workspaceId: op.workspaceId,
              operationId: op.operationId,
              agentId: b.agentId,
              bindingRevision: b.bindingRevision,
            })
          : summary,
      );
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
      const operations = this.journal.leaseBlockers()
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
      return json({schemaVersion:1,workspaceId,observedAt:now,
        activeLease:active,pendingClaimUntil,blockingOperations:operations,
        leaseClaimAvailable:!active&&!pendingClaimUntil&&!operations.length,
        action: operations.some(op=>op.resolvable) ? 'RECONCILE' :
          operations.length ? 'WAIT_FOR_TERMINAL' :
          active||pendingClaimUntil ? 'WAIT_FOR_LEASE' : 'RECONNECT',
      });
    }
    if (path === "/api/v1/tab/claim") {
      const workspaceId = id(b.workspaceId),
        tabInstanceId = id(b.tabInstanceId),
        credential = bearer(request);
      if (b.adapterVersion !== "1")
        throw new ApiError(
          "INCOMPATIBLE_VERSION",
          "Adapter protocol version 1 required.",
          409,
        );
      const current = this.db.get<Lease>("lease");
      if (current && current.expiresAt > Date.now())
        throw new ApiError(
          "TAB_BUSY",
          "Another document has an active lease. Release it or wait for expiry.",
          409,
        );
      const guard = crypto.randomUUID();
      this.db.transaction(() => {
        const claiming = this.db.get<{ expiresAt: number }>("claiming");
        if (claiming && claiming.expiresAt > Date.now())
          throw new ApiError(
            "TAB_BUSY",
            "Lease claim already in progress.",
            409,
          );
        this.db.put("claiming", { guard, expiresAt: Date.now() + 30000 });
      });
      try {
        const approved = await rpc<{
          workspace: WorkspaceRecord;
          credentialEpoch: number;
        }>(registry(this.env), "/internal/claim", {
          workspaceId,
          binding: b.binding,
          credential,
        });
        this.expire();
        if (this.journal.leaseBlocked())
          throw new ApiError("EFFECT_UNKNOWN", "Previous document has an unresolved operation. Reconciliation required before reconnect.", 409);
        const fresh = await rpc<{ epoch: number }>(
          registry(this.env),
          "/internal/epoch",
          { workspaceId, expectedEpoch: approved.workspace.epoch },
        );
        const secret = randomSecret(),
          secretHash = await digest(secret);
        const l: Lease = {
          workspaceId,
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
          this.db.put("lease", l);
          this.db.delete("claiming");
        });
        return json({
          workspaceId,
          epoch: l.epoch,
          bindingRevision: l.bindingRevision,
          tabInstanceId,
          leaseCredential: secret,
          expiresAt: l.expiresAt,
          permissions: l.permissions,
        });
      } catch (error) {
        this.db.delete("claiming");
        throw error;
      }
    }
    if (path === "/internal/resolve") {
      const op = this.db.get<Operation>("operation/" + id(b.operationId));
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
        this.db.put("operation/" + op.operationId, op);
        const current = this.db.get<Lease>("lease");
        if (current) {
          this.db.put(
            "retired/" + current.epoch + "/" + current.tabInstanceId,
            current,
          );
          this.db.delete("lease");
        }
      }
      return json(this.summary(op));
    }
    const l = await this.lease(
      request,
      b,
      path === "/api/v1/tab/reply" && b.phase !== "RUNNING",
    );
    if (path !== "/api/v1/tab/poll") this.expire();
    if (path === "/api/v1/tab/image")
      return json(await this.images.handle(b, l));
    if (path === "/api/v1/tab/music" || path === "/api/v1/tab/music-result")
      return json(await this.music.handle(path, b, l));
    if (path === "/api/v1/tab/release") {
      this.db.put("retired/" + l.epoch + "/" + l.tabInstanceId, l);
      this.db.delete("lease");
      return json({ ok: true });
    }
    if (path === "/api/v1/tab/heartbeat") {
      const valid = await rpc<{ permissions: string[] }>(
        registry(this.env),
        "/internal/lease-check",
        {
          workspaceId: l.workspaceId,
          epoch: l.epoch,
          bindingRevision: l.bindingRevision,
          credentialEpoch: l.credentialEpoch,
        },
      );
      const current = this.db.get<Lease>("lease");
      if (
        !current ||
        current.epoch !== l.epoch ||
        current.tabInstanceId !== l.tabInstanceId
      )
        throw new ApiError("STALE_EPOCH", "Lease changed during renewal.", 409);
      current.expiresAt = Date.now() + 180000;
      current.permissions = valid.permissions;
      this.db.put("lease", current);
      return json({
        expiresAt: current.expiresAt,
        permissions: current.permissions,
      });
    }
    if (path === "/api/v1/tab/poll") {
      // Recheck registry policy through an execution credential-independent lease revision probe at dispatch.
      // Never sleep inside a Durable Object. The outer Worker paces empty responses.
      const refreshed = this.db.get<Lease>("lease");
      if (!refreshed || refreshed.epoch !== l.epoch ||
          refreshed.tabInstanceId !== l.tabInstanceId || refreshed.expiresAt <= Date.now())
        throw new ApiError("STALE_EPOCH", "Lease changed during polling.", 409);
      l.expiresAt = refreshed.expiresAt;
      if (l.expiresAt - Date.now() <= 120000 || !refreshed.claimedAt) {
        refreshed.claimedAt ??= Date.now();
        refreshed.expiresAt = l.expiresAt = Date.now() + 180000;
        this.db.put("lease", refreshed);
      }
      this.expire();
      if(this.journal.running())return json({operations:[],expiresAt:l.expiresAt,idleWaitMs:5000});
      const op=this.journal.nextAdmitted();
      if(!op){
        const idleFor=Date.now()-Math.max(refreshed.claimedAt??Date.now(),this.journal.lastActivityAt());
        return json({operations:[],expiresAt:l.expiresAt,idleWaitMs:idleFor>=120000?15000:5000});
      }
      try {
        await rpc(registry(this.env), "/internal/dispatch", {
          props: op.props,
          agentId: op.agentId,
          permissions: op.requiredPermissions,
          mutating: op.mutating,
          workspaceId: l.workspaceId,
          bindingRevision: l.bindingRevision,
          epoch: l.epoch,
          operationId: op.operationId,
          tool: op.tool,
        });
      } catch (error) {
        op.phase = "REJECTED";
        op.terminalAt = Date.now();
        op.result = {
          error: {
            code: error instanceof ApiError ? error.code : "REVOKED",
            message: "Dispatch rejected after authorization changed.",
          },
        };
        delete op.args;
        this.db.put("operation/" + op.operationId, op);
        return json({ operations: [], expiresAt: l.expiresAt });
      }
      // Lease may be invalidated while the registry permit was in flight.
      const active = this.db.get<Lease>("lease");
      if (
        !active ||
        active.epoch !== op.epoch ||
        active.tabInstanceId !== op.tabInstanceId
      )
        throw new ApiError(
          "STALE_EPOCH",
          "Lease changed before dispatch.",
          409,
        );
      this.db.transaction(() => {
        const fresh = this.db.get<Operation>("operation/" + op.operationId);
        if (fresh.phase !== "ADMITTED")
          throw new ApiError("CONFLICT", "Operation already consumed.", 409);
        fresh.phase = "DISPATCHED";
        this.db.put("operation/" + fresh.operationId, fresh);
      });
      return json({
        operations: [
          {
            version: 1,
            operationId: op.operationId,
            workspaceId: op.workspaceId,
            epoch: op.epoch,
            bindingRevision: op.bindingRevision,
            tabInstanceId: op.tabInstanceId,
            deadlineMs: op.deadlineMs,
            tool: op.tool,
            args: op.args,
            traceId: op.traceId,
            permissions: op.permissions,
          },
        ],
        expiresAt: l.expiresAt,
      });
    }
    if (path === "/api/v1/tab/permit") {
      const op = this.db.get<Operation>("operation/" + id(b.operationId));
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
      return json({
        permissions: op.permissions.filter(
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
        const op = this.db.get<Operation>("operation/" + operationId);
        if (!op || op.epoch !== l.epoch || op.tabInstanceId !== l.tabInstanceId)
          throw new ApiError(
            "STALE_EPOCH",
            "Operation belongs to another lease.",
            409,
          );
        if (op.terminalAt) {
          if (op.phase === "UNKNOWN" && phase !== "RUNNING") {
            op.lateObservation = b.result;
            this.db.put("operation/" + operationId, op);
            return;
          }
          if (
            op.phase === phase &&
            canonical(op.result) === canonical(b.result)
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
        if (phase === "CANCELLED" && op.phase === "RUNNING" && op.mutating)
          throw new ApiError(
            "EFFECT_UNKNOWN",
            "Running mutation cannot be reported cancelled.",
            409,
          );
        op.phase = phase;
        if (phase !== "RUNNING") {
          const retained = this.journal.stats().resultSize;
          op.result =
            retained + JSON.stringify(b.result).length <= 8 * 1024 * 1024
              ? b.result
              : undefined;
          op.terminalAt = Date.now();
          delete op.args;
        }
        this.db.put("operation/" + operationId, op);
      });
      return json({ ok: true });
    }
    throw new ApiError("NOT_FOUND", "Route not found.", 404);
  }
}
