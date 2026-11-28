import { DEFAULT_ACCESS_TOKEN_TTL_SECONDS, grantCleanupDue, grantIsActive, persistentAccessTokenTTL } from './oauth-lifetime.js';
import { withSqlUsage } from "./sql-meter.js";
import { validateRegistryCore, type RegistryCore } from "./registry-core.js";
import { appendOAuthDiagnostic, readOAuthDiagnostics } from "./oauth-diagnostics.js";
import { resourceStorageMaintenance, resourceStorageNeedsMaintenance, resourceStorageStatus, resourceLibraryIsNative, resourceLibraryRevision } from "./resource-storage.js";
import { ResourceError } from "../../../packages/resource-library/src/index.js";
import type { DurableObjectState } from "@cloudflare/workers-types";
import {
  permitsHarNativeAction,
  ApiError,
  DEFAULT_PERMISSIONS,
  VERSION,
  bearer,
  binding,
  canonical,
  configuredBudget,
  digest,
  errorResponse,
  fields,
  id,
  json,
  origin,
  parseBody,
  permissions,
  randomSecret,
  revision,
  str,
  workspace,
  rpc,
  type Binding,
  type Env,
} from "./common.js";
import { SqlRecords } from "./sql.js";
import { RegistryIndex } from "./registry-index.js";
import { incident, incidentSummary, persistIncident, registryFailureReason, registryQuotaDimension, registryFailureSignal } from "./incident.js";
import { requiresGeneratorReservation } from "../../../packages/contracts/src/effect-policy.js";
import { resourceAdmin, resourceTool } from "./resources.js";
import {
  assignmentCount, changeAssignmentIndex, discoverAssignments, initializeAssignments, permissionCeiling,
  projectAssignment, requireAssignment, resolveTarget,
} from './assignments.js';
import { segmentRequestSchema, type SegmentRequest } from '../../../packages/contracts/src/operations-v2.js';
import { nextGeneration, v2DefaultPermissions, workspaceStatusV2Schema } from '../../../packages/contracts/src/target.js';

import {
  bindingOwnerKey, bindingProofKey, matchBindingTransition, parseTransitionInput,
  type BindingAction, type EditorProof, type TransitionInput, type WorkspaceTransition,
} from './binding-transition.js';

export interface WorkspaceRecord {
  contractVersion?: 2;
  connectorId?: string | null;
  assignmentGeneration?: number;
  bindingGeneration?: number;
  permissionRevision?: number;
  transition?: WorkspaceTransition;
  transitionSerial?: number;
  observation?: { epoch: number; dirty: boolean | null; observedAt: number };
  id: string;
  label: string;
  revision: number;
  bindingRevision: number;
  permissions: string[];
  paused: boolean;
  binding: Binding | null;
  recoveryBinding?: { binding: Binding; bindingRevision: number };
  agentId?: string;
  epoch: number;
}
export interface AgentRecord {
  contractVersion?: 2;
  permissionCeiling?: string[];
  id: string;
  label: string;
  workspaceId: string;
  revision: number;
  suspended: boolean;
  endpoint: string;
}
export interface GrantRecord {
  contractVersion?: 2;
  audience?: string;
  credentialEpoch?: number;
  id: string;
  agentId: string;
  workspaceId: string;
  bindingRevision: number;
  permissions: string[];
  state: "active" | "revoked";
  clientId: string;
  expiresAt: number | null;
  revokedAt?: number;
  revision: number;
}
interface Approval {
  contractVersion?: 2;
  connectorRevision?: number;
  credentialEpoch?: number;
  audience?: string;
  id: string;
  code: string;
  kind: "oauth" | "effect";
  digest: string;
  agentId: string;
  workspaceId: string;
  clientId: string;
  redirectUri: string;
  scope: string[];
  expiresAt: number;
  state: "pending" | "approved" | "denied" | "consumed";
  revision: number;
  bindingRevision: number;
  permissionSnapshot: string[];
  policyRevision: number;
  request?: unknown;
  handleHash: string;
  /** Sealed only after the OAuth SDK issued the callback. Private; never exported. */
  completionRedirect?: string;
  completionGrantId?: string;
  completionFailed?: boolean;
  effect?: {
    tool: string;
    argsDigest: string;
    epoch: number;
    sourceRevision?: string;
  };
}
type Core = RegistryCore;
export interface AuthProps {
  contractVersion?: 2;
  audience?: string;
  clientId?: string;
  credentialEpoch?: number;
  grantId: string;
  agentId: string;
  workspaceId: string;
  bindingRevision: number;
}
export class Registry {
  private records?: SqlRecords;
  private derived?: RegistryIndex;
  private storageWakeScheduled = false;
  private get catalog():RegistryIndex {
    if(this.derived)return this.derived;
    const index=new RegistryIndex(this.db,{activityStorageMode:this.env.CANONICAL_STORAGE_MODE});
    // An enclosing transaction may roll back DDL. Cache only committed initialization.
    if(!this.db.inTransaction)this.derived=index;
    return index;
  }
  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {}
  private get db(): SqlRecords {
    // Initialization failures must cross the same redacted fetch error boundary.
    return this.records ??= new SqlRecords(this.state.storage);
  }
  private core(): Core {
    // Do not evaluate deployment defaults for an existing paired installation.
    // A malformed optional ISSUER_URL must not hide the persisted authority.
    const stored = this.db.get<Core>("core");
    const c: Core = stored === undefined ? {
      schemaVersion: 1,
      revision: 1,
      policyRevision: 1,
      paused: false,
      issuer: this.env.ISSUER_URL ? origin(this.env.ISSUER_URL) : null,
      paired: false,
      credentialEpoch: 1,
    } : stored;
    validateRegistryCore(c);
    return c;
  }
  private cleanup(): void {
    const now = Date.now();
    for (const key of this.catalog.due("approval",now))
      if (this.db.get<{ expiresAt: number }>(key).expiresAt < now)
        this.db.delete(key);
    for (const key of this.catalog.due("grant",now)) {
      const grant = this.db.get<GrantRecord>(key);
      if (grant && grantCleanupDue(grant, now)) this.db.delete(key);
    }
    for (const key of this.catalog.due("permit",now)) {
      const row = this.db.get<{ state: string; createdAt?: number }>(key);
      if (
        row.state === "terminal" &&
        row.createdAt !== undefined &&
        row.createdAt + 7 * 86400000 < now
      )
        this.db.delete(key);
    }
    for (const key of this.catalog.due("terminal-notice",now)) {
      const notice = this.db.get<{
        expires: number;
        phase: string;
        event?: { resolution?: unknown; tool?: unknown;
          workspaceId?: unknown; operationId?: unknown; bindingRevision?: unknown;
          phase?: unknown; epoch?: unknown };
      }>(key);
      if (
        notice.expires < now &&
        (!["UNKNOWN", "PARTIAL"].includes(notice.phase) ||
          notice.event?.resolution ||
          notice.event?.tool === "set_viewport_size")
      ) {
        // Retention must not erase the only evidence needed to release a
        // v0.1.4 legacy viewport reservation. Reap by exact identity first.
        const event=notice.event;
        if (event?.tool==="set_viewport_size" &&
            ["PARTIAL","UNKNOWN"].includes(notice.phase) &&
            event.phase===notice.phase &&
            typeof event.workspaceId==="string" &&
            typeof event.operationId==="string" &&
            Number.isSafeInteger(event.bindingRevision) &&
            Number.isSafeInteger(event.epoch)) {
          const w=this.db.get<WorkspaceRecord>("workspace/"+event.workspaceId);
          const key="reservation/"+(w?.binding?.generatorId??"");
          const held=this.db.get<{workspaceId:string;operationId:string}>(key);
          if(w?.binding && w.bindingRevision===event.bindingRevision &&
             held?.workspaceId===w.id && held.operationId===event.operationId)
            this.db.delete(key);
        }
        this.db.delete(key);
        if (notice.event?.resolution)
          this.db.delete(key.replace("terminal-notice/", "resolution/"));
      }
    }
    for (const key of this.catalog.due("idempotency",now))
      if (this.db.get<{ expires: number }>(key).expires < now)
        this.db.delete(key);
  }
  async alarm():Promise<void> {
    return withSqlUsage(this.env.SQL_TELEMETRY_ENABLED==="true","registry","alarm",async()=>{
      this.db.transaction(()=>this.cleanup());
      this.advanceStorage();
      await this.scheduleCleanup();
    });
  }
  private async scheduleCleanup():Promise<void> {
    const due=Math.min(this.catalog.nextDue()??Infinity,this.storagePending()?Date.now()+1000:Infinity), existing=await this.state.storage.getAlarm();
    if(!Number.isFinite(due)){if(existing!==null)await this.state.storage.deleteAlarm();return;}
    const next=Math.max(Date.now()+1000,due+1);
    if(existing===null||existing<=Date.now()||next<existing)await this.state.storage.setAlarm(next);
  }
  private storagePending(): boolean {
    const mode=this.env.CANONICAL_STORAGE_MODE??"legacy";
    return this.catalog.activityMigrationPending()||resourceStorageNeedsMaintenance(this.db,mode);
  }
  private advanceStorage(): unknown {
    const mode=this.env.CANONICAL_STORAGE_MODE??"legacy";
    if(!["legacy","prepare","native"].includes(mode))
      throw new ApiError("INCOMPATIBLE_VERSION","Unrecognized canonical storage mode.",409);
    const activity=this.catalog.advanceActivityMigration(32);
    const resources=resourceStorageMaintenance(this.db,mode,4);
    return {activity,resources};
  }
  private bump(c: Core): void {
    c.revision = nextGeneration(c.revision);
    this.db.put("core", c);
  }
  private getWorkspace(workspaceId: string): WorkspaceRecord {
    const w = this.db.get<WorkspaceRecord>("workspace/" + workspaceId);
    if (!w) throw new ApiError("NOT_FOUND", "Workspace does not exist.", 404);
    return w;
  }
  private getAgent(agentId: string): AgentRecord {
    const a = this.db.get<AgentRecord>("agent/" + agentId);
    if (!a) throw new ApiError("NOT_FOUND", "Agent does not exist.", 404);
    return a;
  }
  private revokeWorkspace(workspaceId: string): void {
    for (const key of this.catalog.grants(workspaceId)) {
      const g = this.db.get<GrantRecord>(key);
      if (g.workspaceId === workspaceId && g.state === "active") {
        g.state = "revoked";
        g.revokedAt = Date.now();
        g.revision++;
        this.db.put(key, g);
      }
    }
  }
  private auth(hash: string, execution = false): Core {
    const c = this.core();
    if (!c.paired || hash !== (execution ? c.executionHash : c.adminHash))
      throw new ApiError(
        "AUTH_REQUIRED",
        "Credential is invalid or revoked.",
        401,
      );
    return c;
  }
  async fetch(request: Request): Promise<Response> {
    return withSqlUsage(this.env.SQL_TELEMETRY_ENABLED==="true","registry",new URL(request.url).pathname,()=>this.fetchMetered(request),this.env.SQL_TELEMETRY_DETAIL_ENABLED==="true");
  }
  private async fetchMetered(request: Request): Promise<Response> {
    let healthStage = "SQL_INIT";
    try {
      if (new URL(request.url).pathname === "/internal/health") {
        // Track the exact failure boundary without reading or exposing unrelated data.
        void this.db;
        healthStage = "CORE_READ";
      }
      const response = await this.route(request);
      const path = new URL(request.url).pathname;
      if(response.ok && ((path.startsWith("/api/v1/admin/")&&request.method!=="GET") ||
         ["/internal/oauth/pending","/internal/oauth/consume","/internal/oauth/redirect-commit","/internal/oauth/abort-completion","/internal/terminal"].includes(path) ||
         (this.env.CANONICAL_STORAGE_MODE!==undefined&&this.env.CANONICAL_STORAGE_MODE!=="legacy"&&
           (!this.storageWakeScheduled||path.startsWith("/api/v1/admin/resources"))))) {
        // A committed request must not be reported failed merely because scheduling failed.
        try {await this.scheduleCleanup();this.storageWakeScheduled=true;} catch { /* Next authenticated mutation retries scheduling. */ }
      }
      return response;
    } catch (error) {
      const traceId = crypto.randomUUID();
      const response = errorResponse(
        error instanceof ResourceError
          ? new ApiError(error.code, error.message,
              error.code === "RESOURCE_NOT_FOUND" ? 404 : 409)
          : error,
        traceId,
      );
      if (response.status >= 500) {
        const event = incident("registry", new URL(request.url).pathname, response.status, error, traceId);
        // Preserve the root error even when Registry admin/diagnostics is unavailable.
        await persistIncident(this.env, event);
      }
      if (new URL(request.url).pathname === "/internal/health") {
        const headers = new Headers(response.headers);
        headers.set("X-Perch-Registry-Failure", registryFailureReason(error));
        headers.set("X-Perch-Registry-Quota", registryQuotaDimension(error));
        headers.set("X-Perch-Registry-Stage", healthStage);
        headers.set("X-Perch-Registry-Signal", registryFailureSignal(error));
        return new Response(response.body, { status: response.status, headers });
      }
      return response;
    }
  }
  private async route(request: Request): Promise<Response> {
    const url = new URL(request.url),
      path = url.pathname;
    if(path==="/internal/sql-usage")return json(this.db.snapshotUsage());
    if (path === "/internal/diagnostic-event") {
      // Called only through the private Durable Object binding by the Worker.
      // No URLs, HTTP headers, OAuth tokens, form fields or source are stored.
      const b = await parseBody(request, 1024);
      fields(b, ["route", "method", "originClass", "status", "code", "traceId"]);
      const route = str(b.route, "route", 32),
        method = str(b.method, "method", 8),
        originClass = str(b.originClass, "originClass", 20),
        code = str(b.code, "code", 40);
      if (
        !["authorize", "authorize_complete", "token", "register"].includes(route) ||
        !["GET", "POST"].includes(method) ||
        !["missing", "null", "same", "perchance", "chatgpt", "other"].includes(originClass) ||
        typeof b.status !== "number" || !Number.isInteger(b.status) || b.status < 200 || b.status > 599 ||
        !/^[a-f0-9-]{36}$/.test(String(b.traceId))
      ) throw new ApiError("INVALID_INPUT", "Invalid bounded diagnostic event.");
      appendOAuthDiagnostic(this.db,b);
      return json({ ok: true });
    }
    if (path === "/internal/registration-budget") {
      return json(
        this.db.transaction(() => {
          const limit = configuredBudget(
              this.env.OAUTH_REGISTRATIONS_PER_HOUR,
              100,
              10000,
            ),
            window = Math.floor(Date.now() / 3600000),
            old = this.db.get<{ window: number; count: number }>(
              "registration-budget",
              { window, count: 0 },
            );
          const count = old.window === window ? old.count : 0;
          if (count >= limit)
            throw new ApiError(
              "QUOTA_EXCEEDED",
              "OAuth registration budget reached; retry after the current hour.",
              429,
            );
          this.db.put("registration-budget", { window, count: count + 1 });
          return { remaining: limit - count - 1 };
        }),
      );
    }
    if (path === "/internal/config") {
      const c = this.core();
      const scope = request.method === "POST" ? await request.json() as {agentId?:unknown} : undefined;
      if (scope && (typeof scope.agentId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(scope.agentId)))
        throw new ApiError("INVALID_INPUT","Invalid internal configuration scope.",400);
      const keys = scope ? ["agent/"+scope.agentId] : this.db.keys("agent/");
      return json({
        issuer: c.issuer,
        paired: c.paired,
        resources: keys
          .map((k) => this.db.get<AgentRecord|undefined>(k))
          .filter((a):a is AgentRecord => !!a && (!a.suspended || a.contractVersion === 2))
          .map((a) => a.endpoint),
        version: VERSION,
        schemaVersion: 1,
      });
    }
    if (path === "/internal/health") {
      const c = this.core();
      return json({
        ok: true,
        version: VERSION,
        schemaVersion: 1,
        storageSchemaVersion: c.schemaVersion,
        paired: c.paired,
        configured: !!c.issuer,
        providerWritesEnabled: this.env.PROVIDER_WRITES_ENABLED === "true",
        nativeActionsEnabled: this.env.NATIVE_ACTIONS_ENABLED === "true",
        protocolVersions: ["2026-07-28", "2025-11-25", "2025-06-18"],
      });
    }
    if (path === "/api/v1/admin/pair") {
      if (request.method !== "POST")
        throw new ApiError("INVALID_INPUT", "POST required.", 405);
      const b = await parseBody(request);
      fields(b, ["bootstrapSecret", "browserInstallationId", "issuer"]);
      const secret = str(b.bootstrapSecret, "bootstrapSecret", 256);
      if (
        secret.length < 43 ||
        !this.env.BOOTSTRAP_SECRET ||
        (await digest(secret)) !== (await digest(this.env.BOOTSTRAP_SECRET))
      )
        throw new ApiError("AUTH_REQUIRED", "Invalid bootstrap secret.", 401);
      const installation = id(b.browserInstallationId, "browserInstallationId"),
        admin = randomSecret(),
        execution = randomSecret(),
        adminHash = await digest(admin),
        executionHash = await digest(execution);
      this.db.transaction(() => {
        const c = this.core();
        if (c.paired)
          throw new ApiError(
            "BOOTSTRAP_CONSUMED",
            "Already paired. Use dashboard recovery.",
            409,
          );
        c.issuer = c.issuer ?? origin(str(b.issuer, "issuer", 2000));
        c.paired = true;
        c.adminHash = adminHash;
        c.executionHash = executionHash;
        c.browserInstallationId = installation;
        this.bump(c);
      });
      return json({
        adminCredential: admin,
        executionCredential: execution,
        browserInstallationId: installation,
      });
    }
    if (path === "/api/v1/admin/recover") {
      if (request.method !== "POST")
        throw new ApiError("INVALID_INPUT", "POST required.", 405);
      const b = await parseBody(request);
      fields(b, ["recoverySecret", "browserInstallationId"]);
      const s = str(b.recoverySecret, "recoverySecret", 256);
      if (
        s.length < 43 ||
        !this.env.RECOVERY_SECRET ||
        (await digest(s)) !== (await digest(this.env.RECOVERY_SECRET))
      )
        throw new ApiError("AUTH_REQUIRED", "Invalid recovery secret.", 401);
      const h = await digest(s),
        admin = randomSecret(),
        execution = randomSecret(),
        ah = await digest(admin),
        eh = await digest(execution),
        installation = id(b.browserInstallationId, "browserInstallationId");
      this.db.transaction(() => {
        const c = this.core();
        if (c.recoveryHash === h)
          throw new ApiError(
            "RECOVERY_CONSUMED",
            "Rotate the dashboard recovery secret before another recovery.",
            409,
          );
        c.recoveryHash = h;
        c.adminHash = ah;
        c.executionHash = eh;
        c.browserInstallationId = installation;
        c.paired = true;
        c.credentialEpoch++;
        c.paused = true;
        c.policyRevision++;
        for (const key of this.db.keys("workspace/")) {
          const w = this.db.get<WorkspaceRecord>(key);
          if (w.binding)
            w.recoveryBinding = {
              binding: w.binding,
              bindingRevision: w.bindingRevision,
            };
          if (w.contractVersion === 2) {
            if (w.binding) this.db.delete(bindingOwnerKey(w.binding.generatorId));
            w.bindingGeneration = nextGeneration(requireAssignment(w).bindingGeneration);
            delete w.transition;
            delete w.observation;
          }
          w.binding = null;
          w.bindingRevision = nextGeneration(w.bindingRevision);
          w.epoch = nextGeneration(w.epoch);
          w.revision = nextGeneration(w.revision);
          w.paused = true;
          this.db.put(key, w);
          this.revokeWorkspace(w.id);
        }
        this.bump(c);
      });
      return json({
        adminCredential: admin,
        executionCredential: execution,
        browserInstallationId: installation,
        paused: true,
      });
    }
    if (path === "/internal/oauth/pending") {
      const b = await parseBody(request),
        auth = b.request as Record<string, unknown>;
      if (!auth || typeof auth.resource !== "string")
        throw new ApiError(
          "INVALID_INPUT",
          "Validated OAuth request required.",
        );
      const baseline = this.core();
      const prefix = baseline.issuer + '/mcp/';
      if (!auth.resource.startsWith(prefix)) throw new ApiError('INVALID_TARGET', 'Unknown Connector resource.');
      const a = this.db.get<AgentRecord | undefined>('agent/' + id(auth.resource.slice(prefix.length)));
      if (!a || a.endpoint !== auth.resource || a.suspended)
        throw new ApiError('INVALID_TARGET', 'Unknown Connector resource.');
      const isV2 = a.contractVersion === 2;
      const w = isV2 ? null : this.getWorkspace(a.workspaceId);
      if (isV2) this.requireDevelopmentContract(baseline);
      if (w && !w.binding)
        throw new ApiError(
          "BINDING_MISMATCH",
          "Attach the Workspace before authorization.",
          409,
        );
      if (w?.paused || baseline.paused)
        throw new ApiError("PAUSED", "Execution is paused.", 403);
      const ceiling = isV2 ? permissionCeiling(a.permissionCeiling) : w!.permissions;
      const handle = randomSecret(),
        handleHash = await digest(handle),
        requestDigest = await digest(
          canonical({
            request: auth,
            contractVersion: isV2 ? 2 : 1,
            bindingRevision: w?.bindingRevision ?? 0,
            connectorRevision: a.revision,
            credentialEpoch: baseline.credentialEpoch,
            permissions: ceiling,
            policyRevision: baseline.policyRevision,
          }),
        ),
        approvalId = crypto.randomUUID();
      const approval: Approval = {
        id: approvalId,
        code: crypto.randomUUID().slice(0, 8).toUpperCase(),
        kind: "oauth",
        digest: requestDigest,
        agentId: a.id,
        workspaceId: w?.id ?? '',
        ...(isV2 ? { contractVersion: 2 as const, connectorRevision: a.revision,
          credentialEpoch: baseline.credentialEpoch, audience: a.endpoint } : {}),
        clientId: String(auth.clientId),
        redirectUri: String(auth.redirectUri),
        scope: Array.isArray(auth.scope) ? (auth.scope as string[]) : [],
        expiresAt: Date.now() + 300000,
        state: "pending",
        revision: 1,
        bindingRevision: w?.bindingRevision ?? 0,
        permissionSnapshot: [...ceiling],
        policyRevision: baseline.policyRevision,
        request: auth,
        handleHash,
      };
      this.db.transaction(() => {
        const c = this.core();
        this.verifyApprovalScope(approval, c);
        this.cleanup();
        if (
          this.catalog.approvalFull(Date.now())
        )
          throw new ApiError(
            "QUEUE_FULL",
            "Too many pending authorizations.",
            429,
          );
        this.db.put("approval/" + approvalId, approval);
        this.bump(c);
      });
      return json({
        id: approvalId,
        code: approval.code,
        handle,
        agentLabel: a.label,
        workspaceLabel: w?.label ?? null,
        contractVersion: isV2 ? 2 : 1,
        permissionCeiling: isV2 ? ceiling : undefined,
        clientId: approval.clientId,
        redirectUri: approval.redirectUri,
        scope: approval.scope,
        expiresAt: approval.expiresAt,
      });
    }
    if (path === "/internal/oauth/consume") {
      const b = await parseBody(request),
        approvalId = id(b.id),
        hash = await digest(str(b.handle, "handle", 128));
      return json(
        this.db.transaction(() => {
          const a = this.db.get<Approval>("approval/" + approvalId);
          if (!a || a.handleHash !== hash)
            throw new ApiError(
              "AUTH_REQUIRED",
              "Invalid authorization handle.",
              401,
            );
          if (a.expiresAt <= Date.now())
            throw new ApiError("EXPIRED", "Authorization expired.", 410);
          if (a.state === "pending") return { state: a.state };
          if (a.state === "denied") {
            a.state = "consumed";
            this.db.put("approval/" + a.id, a);
            return { state: "denied", request: a.request };
          }
          if (a.state === "consumed") {
            if (a.completionRedirect) {
              const grant = a.completionGrantId
                ? this.db.get<GrantRecord>("grant/" + a.completionGrantId) : null;
              return grantIsActive(grant)
                ? { state: "completed", redirectTo: a.completionRedirect }
                : { state: "revoked" };
            }
            return { state: a.completionFailed ? "failed" : a.completionGrantId ? "processing" : "consumed" };
          }
          if (a.state !== "approved") return { state: a.state };
          const c = this.core();
          this.verifyApprovalScope(a, c);
          this.cleanup();
          if (
            this.catalog.activeGrantCount(Date.now()) >=
            configuredBudget(this.env.REGISTRY_GRANT_BUDGET, 1000)
          )
            throw new ApiError(
              "QUOTA_EXCEEDED",
              "Active Grant budget reached; explicitly revoke an unused Grant before authorizing another.",
              429,
            );
          const g: GrantRecord = {
            id: crypto.randomUUID(),
            agentId: a.agentId,
            workspaceId: a.workspaceId,
            bindingRevision: a.bindingRevision,
            permissions: [...a.permissionSnapshot],
            ...(a.contractVersion === 2 ? { contractVersion: 2 as const,
              audience: a.audience, credentialEpoch: a.credentialEpoch } : {}),
            state: "active",
            clientId: a.clientId,
            expiresAt: a.contractVersion === 2 ? null : Date.now() + 30 * 86400000,
            revision: 1,
          };
          a.state = "consumed";
          a.completionGrantId = g.id;
          this.db.put("approval/" + a.id, a);
          this.db.put("grant/" + g.id, g);
          return {
            state: "approved",
            request: a.request,
            grant: g,
            props: {
              grantId: g.id,
              agentId: g.agentId,
              workspaceId: g.workspaceId,
              bindingRevision: g.bindingRevision,
              ...(g.contractVersion === 2 ? { contractVersion: 2 as const,
                audience: g.audience, clientId: g.clientId, credentialEpoch: g.credentialEpoch } : {}),
            },
          };
        }),
      );
    }
    if (path === "/internal/oauth/redirect-commit") {
      const b = await parseBody(request, 8192);
      fields(b, ["id", "handle", "grantId", "redirectTo"]);
      const approvalId = id(b.id),
        handleHash = await digest(str(b.handle, "handle", 128)),
        grantId = id(b.grantId),
        redirectTo = str(b.redirectTo, "redirectTo", 4096);
      return json(this.db.transaction(() => {
        const a = this.db.get<Approval>("approval/" + approvalId);
        if (!a || a.handleHash !== handleHash)
          throw new ApiError("AUTH_REQUIRED", "Invalid authorization handle.", 401);
        if (a.expiresAt <= Date.now())
          throw new ApiError("EXPIRED", "Authorization window expired before callback issuance.", 410);
        if (a.state !== "consumed" || a.completionGrantId !== grantId || a.completionFailed)
          throw new ApiError("CONFLICT", "Authorization is not awaiting this redirect.", 409);
        if (a.completionRedirect) {
          if (a.completionRedirect !== redirectTo)
            throw new ApiError("CONFLICT", "Authorization redirect cannot change.", 409);
          return { ok: true };
        }
        // Defense in depth: SDK validated redirect URI, but reject any
        // off-client callback. It contains a PKCE authorization code:
        // never include it in logs, audit events or admin projections.
        const expected = new URL(a.redirectUri), received = new URL(redirectTo);
        if (
          expected.protocol !== received.protocol ||
          expected.host !== received.host ||
          expected.origin !== received.origin ||
          expected.pathname !== received.pathname ||
          received.username || received.password || received.hash ||
          !received.searchParams.get("code") ||
          [...expected.searchParams].some(([key, value]) =>
            received.searchParams.get(key) !== value)
        ) throw new ApiError("INVALID_INPUT", "OAuth callback redirect does not match the approved client.");
        const g = this.db.get<GrantRecord>("grant/" + grantId);
        if (!g || g.state !== "active" || g.agentId !== a.agentId ||
            g.workspaceId !== a.workspaceId || g.clientId !== a.clientId)
          throw new ApiError("REVOKED", "OAuth grant was invalidated.", 403);
        a.completionRedirect = redirectTo;
        this.db.put("approval/" + a.id, a);
        return { ok: true };
      }));
    }
    if (path === "/internal/oauth/abort-completion") {
      const b = await parseBody(request, 1024);
      fields(b, ["id", "handle", "grantId"]);
      const approvalId = id(b.id),
        handleHash = await digest(str(b.handle, "handle", 128)),
        grantId = id(b.grantId);
      return json(this.db.transaction(() => {
        const a = this.db.get<Approval>("approval/" + approvalId);
        if (!a || a.handleHash !== handleHash)
          throw new ApiError("AUTH_REQUIRED", "Invalid authorization handle.", 401);
        if (a.state !== "consumed" || a.completionGrantId !== grantId)
          throw new ApiError("CONFLICT", "Authorization cannot be aborted.", 409);
        if (a.completionRedirect)
          return { ok: false, alreadyCompleted: true };
        a.completionFailed = true;
        this.db.put("approval/" + a.id, a);
        const g = this.db.get<GrantRecord>("grant/" + grantId);
        if (g && g.state === "active") {
          g.state = "revoked";
          g.revokedAt = Date.now();
          g.revision++;
          this.db.put("grant/" + g.id, g);
        }
        return { ok: true };
      }));
    }
    if (path === "/internal/resource-tool") {
      const b = await parseBody(request);
      if ((b.props as AuthProps | undefined)?.contractVersion === 2)
        throw new ApiError('NOT_FOUND', 'Resource tools are unavailable under the development contract.', 404);
      const authorized = this.authorize(b);
      return json(
        await resourceTool(
          this.db,
          String(b.tool),
          b.args as Record<string, unknown>,
          {
            workspaceId: authorized.workspace.id,
            agentId: authorized.agent.id,
          },
        ),
      );
    }
    // Token renewal authenticates consent, not current execution eligibility.
    if (path === "/internal/oauth/token-authorize") {
      const b = await parseBody(request);
      return json(this.db.transaction(() => {
        if ((b.props as AuthProps | undefined)?.contractVersion === 2) {
          this.authenticateConnector(b, true);
          return { ok: true };
        }
        this.authorize(b);
        return { ok: true };
      }));
    }
    if (path === "/internal/authorize") {
      const b = await parseBody(request);
      if ((b.props as AuthProps | undefined)?.contractVersion === 2 && b.target === undefined)
        return json(this.db.transaction(() => {
          const { agent, grant } = this.authenticateConnector(b);
          return { agent, grant };
        }));
      return json(this.db.transaction(() => this.authorize(b)));
    }
    if (path === "/internal/v2/discover") {
      const b = await parseBody(request);
      const parsed = workspaceStatusV2Schema.safeParse(b.args);
      if (!parsed.success) throw new ApiError("INVALID_INPUT", "Invalid workspace_status arguments.");
      const args = parsed.data;
      return json(this.db.transaction(() => {
        const { agent, grant } = this.authenticateConnector(b);
        const common = { contractVersion: 2, connectorId: agent.id, serverTimeMs: Date.now() };
        if (args.target === undefined)
          return { ...common, ...discoverAssignments(this.db, agent.id, grant.permissions, args.limit ?? 50, args.cursor) };
        const w = resolveTarget(this.db, agent.id, args.target);
        if (args.verifySource)
          throw new ApiError("UPGRADE_REQUIRED", "Verified browser source is unavailable during contract preparation.", 409);
        const readable = grant.permissions.includes('READ_SOURCE') && w.permissions.includes('READ_SOURCE');
        const observed = w.observation?.epoch===w.epoch ? w.observation : undefined;
        const reason = readable ? 'NOT_VERIFIED_IN_REGISTRY' : 'SCOPE_DENIED';
        const revision = {value:null,verified:false,reason};
        const projection=projectAssignment(w,grant.permissions);
        return { ...common, ...projection,
          sourceRevision:revision,localRevision:revision,previewRevision:revision,savedRevision:revision,
          ...(args.detail === true ? {
            diagnostics: {
              observationEpoch:readable?observed?.epoch??null:null,
              bindingEpoch:readable?w.epoch:null,
              observationAgeMs:observed?Math.max(0,Date.now()-observed.observedAt):null,
              observationVerification:'HEARTBEAT_ONLY',
              blockers:[...(!w.binding?['UNBOUND']:[]),...(w.paused?['PAUSED']:[]),
                ...(w.transition?['TRANSITION_PENDING']:[]),
                ...(!observed?['NO_OBSERVATION']:observed.observedAt+60_000<Date.now()?['STALE_HEARTBEAT']:[])],
            },
            negotiatedLimits: {maxWorkspaces:50,maxFiles:1000,maxBatchActions:32,
              maxInlineResultBytes:256*1024,maxStagedFileBytes:16*1024*1024},
          } : {}) };
      }));
    }
    if (path === '/api/v1/tab/rebind-proof') {
      if (request.method !== 'POST') throw new ApiError('INVALID_INPUT', 'POST required.', 405);
      const body = await parseBody(request, 4096);
      fields(body, ['workspaceId', 'expectedRevision', 'binding', 'tabInstanceId', 'adapterVersion']);
      id(body.tabInstanceId, 'tabInstanceId');
      if (body.adapterVersion !== '2') throw new ApiError('UPGRADE_REQUIRED', 'Adapter protocol version 2 required.', 409);
      const hash = await digest(bearer(request));
      const proof = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, '0')).join('');
      const proofDigest = await digest(proof);
      const candidate = binding(body.binding);
      return json(this.db.transaction(() => {
        const core = this.auth(hash, true);
        this.requireDevelopmentContract(core);
        const w = requireAssignment(this.getWorkspace(id(body.workspaceId)));
        revision(body.expectedRevision, w.revision);
        if (candidate.browserInstallationId !== core.browserInstallationId)
          throw new ApiError('BINDING_MISMATCH', 'Destination editor installation differs.', 409);
        const row: EditorProof = { digest: proofDigest, binding: candidate, workspaceRevision: w.revision,
          credentialEpoch: core.credentialEpoch, expiresAt: Date.now() + 30_000 };
        this.db.put(bindingProofKey(w.id), row);
        return { proof, expiresAt: row.expiresAt };
      }));
    }
    if (path === '/internal/operator-restore-fence') {
      const b = await parseBody(request, 4096);
      return json(this.db.transaction(() => {
        const core = this.core(), w = requireAssignment(this.getWorkspace(id(b.workspaceId)));
        this.requireDevelopmentContract(core);
        if (!w.binding || w.transition || core.paused || w.paused || w.epoch !== b.epoch ||
            w.bindingRevision !== b.bindingRevision || core.credentialEpoch !== b.credentialEpoch ||
            !w.permissions.includes('WRITE_SOURCE'))
          throw new ApiError('SCOPE_DENIED', 'Exact Operator restore authority changed.', 403);
        const operationId = id(b.operationId);
        if (this.db.get('terminal-notice/' + w.id + '/' + operationId) ||
            this.db.get('resolution/' + w.id + '/' + operationId))
          throw new ApiError('CONFLICT', 'The exact Operator restore is already terminal.', 409);
        const key = 'reservation/' + w.binding.generatorId;
        const current = this.db.get<{operationId: string; workspaceId: string; epoch?: number; operatorRestore?: boolean}>(key);
        if (current?.operatorRestore && current.operationId === operationId &&
            current.workspaceId === w.id && current.epoch === w.epoch) return {operationId};
        if (current || b.action !== 'acquire')
          throw new ApiError('TRANSITION_BLOCKED', 'An exact Operator restore writer reservation is unavailable.', 409);
        this.db.put(key, {operationId, workspaceId: w.id, epoch: w.epoch, operatorRestore: true});
        return {operationId};
      }));
    }
    if (path === "/internal/lease-check") {
      const b = await parseBody(request),
        c = this.core(),
        w = this.getWorkspace(id(b.workspaceId));
      if (
        c.credentialEpoch !== b.credentialEpoch ||
        c.paused ||
        w.paused ||
        w.epoch !== b.epoch ||
        w.bindingRevision !== b.bindingRevision ||
        !w.binding
      )
        throw new ApiError("REVOKED", "Lease binding or policy changed.", 403);
      if (w.contractVersion === 2) {
        this.requireDevelopmentContract(c);
        if (b.adapterVersion !== '2') throw new ApiError('UPGRADE_REQUIRED', 'Adapter protocol version 2 required.', 409);
        if (b.dirty === null || typeof b.dirty === 'boolean') {
          const now = Date.now();
          if (!w.observation || w.observation.epoch !== w.epoch ||
              w.observation.dirty !== b.dirty || w.observation.observedAt + 60_000 <= now) {
            w.observation = { epoch: w.epoch, dirty: b.dirty, observedAt: now };
            this.db.put('workspace/' + w.id, w);
          }
        }
      }
      return json({ permissions: w.permissions });
    }
    if (path === "/internal/claim") {
      const b = await parseBody(request),
        hash = await digest(str(b.credential, "credential", 1024)),
        proposed = binding(b.binding),
        workspaceId = id(b.workspaceId);
      return json(
        this.db.transaction(() => {
          const c = this.auth(hash, true),
            w = this.getWorkspace(workspaceId);
          if (c.paused || w.paused)
            throw new ApiError("PAUSED", "Execution is paused.", 403);
          if (w.transition) throw new ApiError('TRANSITION_BLOCKED', 'Workspace transition is pending.', 409);
          if (w.contractVersion === 2) {
            this.requireDevelopmentContract(c);
            requireAssignment(w);
            if (b.adapterVersion !== '2')
              throw new ApiError('UPGRADE_REQUIRED', 'Adapter protocol version 2 required.', 409);
          } else if (b.adapterVersion === '2') {
            throw new ApiError('UPGRADE_REQUIRED', 'Workspace uses adapter protocol version 1.', 409);
          }
          if (
            !w.binding ||
            canonical(w.binding) !== canonical(proposed) ||
            w.binding.browserInstallationId !== c.browserInstallationId
          )
            throw new ApiError(
              "BINDING_MISMATCH",
              "Workspace binding differs from current editor.",
              409,
            );
          // Legacy (v0.1.4) incorrectly held the generator writer on
          // a terminal CSS-only viewport reset. Release only when a matched,
          // authenticated Durable Object terminal notice proves its scope.
          // No outcome is rewritten or claimed successful.
          const reservationKey = "reservation/" + w.binding.generatorId;
          const held = this.db.get<{workspaceId:string;operationId:string}>(reservationKey);
          if (held?.workspaceId === w.id) {
            const notice = this.db.get<{
              phase:string; event?:{
                operationId:string;workspaceId:string;tool:string;phase:string;
                bindingRevision:number;epoch:number;
              };
            }>("terminal-notice/" + w.id + "/" + held.operationId);
            const ev = notice?.event;
            if (ev && ev.operationId === held.operationId &&
                ev.workspaceId === w.id && ev.tool === "set_viewport_size" &&
                (notice?.phase === "PARTIAL" || notice?.phase === "UNKNOWN") &&
                ev.phase === notice.phase && ev.bindingRevision === w.bindingRevision &&
                Number.isSafeInteger(ev.epoch) && ev.epoch <= w.epoch)
              this.db.delete(reservationKey);
          }
          return { workspace: w, credentialEpoch: c.credentialEpoch };
        }),
      );
    }
    if (path === '/internal/v2/segment') {
      const b = await parseBody(request, 8192);
      const parsed = segmentRequestSchema.safeParse(b.segment);
      if (!parsed.success || (b.props as AuthProps | undefined)?.contractVersion !== 2)
        throw new ApiError('INVALID_INPUT', 'Exact v2 segment required.');
      const segment = parsed.data;
      return json(this.db.transaction(() => {
        const {workspace: w, grant} = this.authorize(b);
        const operationId = id(b.operationId);
        const key = 'permit/' + operationId;
        const parent = this.db.get<{workspaceId: string; epoch: number; state: string; target?: string;
          grantId?: string; segments?: SegmentRequest[]; transferRecoveryOnly?: true} | undefined>(key);
        if (!parent || parent.state !== 'consumed' || parent.workspaceId !== w.id || parent.grantId !== grant.id ||
            parent.target !== b.target || parent.epoch !== w.epoch || b.epoch !== w.epoch ||
            b.bindingRevision !== w.bindingRevision)
          throw new ApiError('STALE_EPOCH', 'Segment has no current consumed parent authority.', 409);
        if (parent.transferRecoveryOnly)
          throw new ApiError('SCOPE_DENIED', 'Transfer recovery has no effect-capable segment authority.', 403);
        const previous = parent.segments ?? [];
        if (segment.sequence !== previous.length || previous.length >= 128)
          throw new ApiError('CONFLICT', 'Segment permit is already consumed or out of sequence.', 409);
        this.db.put(key, {...parent, segments: [...previous, segment]});
        return {operationId, sequence: segment.sequence, digest: segment.digest, expiresAt: Date.now() + 5000};
      }));
    }
    if (path === "/internal/dispatch") {
      const b = await parseBody(request);
      return json(
        this.db.transaction(() => {
          const result = this.authorize(b),
            w = result.workspace;
          revision(b.bindingRevision, w.bindingRevision);
          if (b.epoch !== w.epoch)
            throw new ApiError("STALE_EPOCH", "Workspace epoch changed.", 409);
          const operationId = id(b.operationId);
          // Cancellation/expiry may publish before a delayed dispatch RPC.
          // A receipt is terminal authority even without a consumed permit.
          if(this.db.get("terminal-notice/"+w.id+"/"+operationId)!==undefined)
            throw new ApiError("CONFLICT","Operation already has a terminal receipt.",409);
          const prior = this.db.get<{
            workspaceId: string;
            epoch: number;
            state: string;
          }>("permit/" + operationId);
          if (prior) {
            if (
              prior.workspaceId !== w.id ||
              prior.epoch !== w.epoch ||
              prior.state === "terminal"
            )
              throw new ApiError(
                "CONFLICT",
                "Dispatch permit is already terminal or belongs to another epoch.",
                409,
              );
            return result;
          }
          const transferRecoveryOnly = b.transferRecoveryOnly === true && w.contractVersion === 2 && b.tool === 'write';
          this.db.put("permit/" + operationId, {
            workspaceId: w.id,
            epoch: w.epoch,
            createdAt: Date.now(),
            state: "consumed",
            ...(result.grant.contractVersion === 2 ? {target: b.target, grantId: result.grant.id} : {}),
            ...(transferRecoveryOnly ? {transferRecoveryOnly: true} : {}),
          });
          if (!transferRecoveryOnly && requiresGeneratorReservation(String(b.tool ?? ''), b.mutating === true) && w.binding) {
            const key = "reservation/" + w.binding.generatorId,
              existing = this.db.get<{
                workspaceId: string;
                operationId: string;
              }>(key);
            if (
              existing &&
              (existing.workspaceId !== w.id ||
                existing.operationId !== b.operationId)
            )
              throw new ApiError(
                "TAB_BUSY",
                "Another Workspace owns the generator writer reservation.",
                409,
              );
            this.db.put(key, {
              workspaceId: w.id,
              operationId: id(b.operationId),
              epoch: w.epoch,
            });
          }
          return result;
        }),
      );
    }
    if (path === "/internal/epoch") {
      const b = await parseBody(request);
      return json(
        this.db.transaction(() => {
          const w = this.getWorkspace(id(b.workspaceId));
          if (b.expectedEpoch !== w.epoch || w.transition ||
              (b.expectedBindingRevision !== undefined && b.expectedBindingRevision !== w.bindingRevision))
            throw new ApiError("STALE_EPOCH", "Epoch or Binding changed.", 409);
          w.epoch = nextGeneration(w.epoch);
          this.db.put("workspace/" + w.id, w);
          return { epoch: w.epoch };
        }),
      );
    }
    if (path === "/internal/terminal") {
      const b = await parseBody(request);
      this.db.transaction(() => {
        const w = this.getWorkspace(id(b.workspaceId)),
          operationId = id(b.operationId);
        if (
          ![
            "SUCCEEDED",
            "REJECTED",
            "UNKNOWN",
            "PARTIAL",
            "CANCELLED",
          ].includes(String(b.status))
        )
          throw new ApiError(
            "INVALID_INPUT",
            "Terminal notice status required.",
          );
        const key = "terminal-notice/" + w.id + "/" + operationId,
          prior = this.db.get<{ phase: string }>(key);
        if (prior) {
          if (prior.phase !== b.status)
            throw new ApiError(
              "CONFLICT",
              "Terminal notice cannot rewrite the original outcome.",
              409,
            );
          return;
        }
        const terminalBinding = w.binding ?? w.recoveryBinding?.binding;
        if (
          terminalBinding &&
          (!["UNKNOWN", "PARTIAL"].includes(String(b.status)) ||
            b.tool === "set_viewport_size")
        ) {
          const reservedKey = "reservation/" + terminalBinding.generatorId,
            existing = this.db.get<{ operationId: string }>(reservedKey);
          if (existing?.operationId === operationId)
            this.db.delete(reservedKey);
        }
        this.db.put("permit/" + operationId, {
          workspaceId: w.id,
          epoch: b.epoch,
          createdAt: Date.now(),
          state: "terminal",
        });
        const event = {
          operationId,
          workspaceId: w.id,
          tool: b.tool,
          phase: b.status,
          epoch: b.epoch,
          bindingRevision: b.bindingRevision,
          traceId: b.traceId,
          timestamp: b.timestamp ?? Date.now(),
          durationMs: b.durationMs ?? 0,
          ...(b.errorCode ? { errorCode: b.errorCode } : {}),
          ...((this.db.get("resolution/" + w.id + "/" + operationId) ??
          b.resolution)
            ? {
                resolution:
                  this.db.get("resolution/" + w.id + "/" + operationId) ??
                  b.resolution,
              }
            : {}),
        };
        this.db.put(key, {
          phase: b.status,
          event,
          expires: Date.now() + 7 * 86400000,
        });
        this.catalog.appendActivity(event);
        this.bump(this.core());
      });
      return json({ ok: true });
    }
    if (!path.startsWith("/api/v1/admin/"))
      throw new ApiError("NOT_FOUND", "Route not found.", 404);
    const hash = await digest(bearer(request));
    this.auth(hash);
    if (path.startsWith("/api/v1/admin/resources")) {
      // v2 retires active Resource authoring and prevents lazy seed on fresh
      // installations. Historical bytes remain accessible through explicit
      // read-only export; no automatic migration, mutation or deletion.
      if (this.core().assignmentContractVersion === 2) {
        if (path !== "/api/v1/admin/resources/export" || request.method !== "GET")
          throw new ApiError("UPGRADE_REQUIRED", "The legacy Resource interface is retired for v2.", 410);
        if (this.db.get("library") === undefined && !resourceLibraryIsNative(this.db))
          throw new ApiError("NOT_FOUND", "No historical Resource archive is stored.", 404);
      }
      return resourceAdmin(request, this.db, () => {
        this.auth(hash);
      });
    }
    if (request.method === "GET") return this.readAdmin(path, url);
    const expectedMethod =
      /^\/api\/v1\/admin\/(workspaces|agents|connectors)\/[^/]+$/.test(path)
        ? "PATCH"
        : "POST";
    if (request.method !== expectedMethod)
      throw new ApiError("INVALID_INPUT", expectedMethod + " required.", 405);
    const b = await parseBody(request),
      key = id(request.headers.get("Idempotency-Key"), "Idempotency-Key"),
      requestHash = await digest(
        canonical({ path, method: request.method, body: b }),
      );
    const upgrade = request.method === 'POST' && /^\/api\/v1\/admin\/connectors\/([A-Za-z0-9_-]{1,128})\/upgrade$/.exec(path);
    if (upgrade) {
      this.assertManagementKey(key);
      return json(await this.upgradeConnector(hash,path,upgrade[1]!,key,requestHash,b));
    }
    const abort = request.method === 'POST' && /^\/api\/v1\/admin\/workspaces\/([A-Za-z0-9_-]{1,128})\/abort-transition$/.exec(path);
    if (abort) {
      this.assertManagementKey(key);
      return json(await this.abortBindingChange(hash, abort[1]!, key, requestHash, b));
    }
    const action = request.method === 'POST' ? matchBindingTransition(path) : null;
    if (action && this.getWorkspace(action.workspaceId).contractVersion === 2) {
      this.assertManagementKey(key);
      return json(await this.changeBinding(hash, path, action.workspaceId, action.action, key, requestHash, b));
    }
    return this.db.transaction(() => {
      const c = this.auth(hash),
        idem = this.db.get<{ hash: string; result: unknown; expires: number }>(
          "idempotency/" + key,
        );
      if (idem && idem.expires > Date.now()) {
        if (idem.hash !== requestHash)
          throw new ApiError(
            "IDEMPOTENCY_CONFLICT",
            "Idempotency key was used for a different request.",
            409,
          );
        return json(idem.result);
      }
      this.cleanup();
      if (this.catalog.count("idempotency") >= 1024)
        throw new ApiError(
          "QUOTA_EXCEEDED",
          "Management idempotency budget reached; wait for expiration.",
          429,
        );
      const result = this.writeAdmin(path, b, c);
      // Migration may atomically fence old binaries. Preserve its newer
      // persisted schema marker when bumping the management revision.
      if(path==="/api/v1/admin/storage/step")c.schemaVersion=this.core().schemaVersion;
      this.db.put("idempotency/" + key, {
        hash: requestHash,
        result,
        expires: Date.now() + 86400000,
      });
      this.bump(c);
      return json(result);
    });
  }
  private async upgradeConnector(authHash: string, path: string, connectorId: string, key: string, requestHash: string,
      body: Record<string,unknown>): Promise<unknown> {
    fields(body,['expectedRevision','expectedWorkspaceRevision','acknowledgeReauthorization']);
    if (body.acknowledgeReauthorization !== true)
      throw new ApiError('APPROVAL_REQUIRED','Confirm replacement of the fixed-scope v1 Grant.',409);
    if (this.env.DEVELOPMENT_CONTRACT_V2_ENABLED !== 'true')
      throw new ApiError('UPGRADE_REQUIRED','The v2 assignment contract is disabled.',409);
    const resultKey='idempotency/'+key;
    const previous=()=>{
      const receipt=this.db.get<{hash:string;result:unknown;expires:number}|undefined>(resultKey);
      if (!receipt || receipt.expires<=Date.now()) return undefined;
      if (receipt.hash!==requestHash) throw new ApiError('IDEMPOTENCY_CONFLICT','Management key belongs to a different request.',409);
      return receipt;
    };
    const started=this.db.transaction(()=>{
      const core=this.auth(authHash);
      const receipt=previous();
      if (receipt) return {receipt} as const;
      const a=this.getAgent(connectorId);
      if (a.contractVersion!==undefined || a.suspended)
        throw new ApiError('CONFLICT','Connector is not an active fixed-scope v1 Connector.',409);
      const w=this.getWorkspace(a.workspaceId);
      if (w.contractVersion!==undefined || w.agentId!==a.id || !w.binding)
        throw new ApiError('BINDING_MISMATCH','A matching existing v1 Binding is required.',409);
      revision(body.expectedRevision,a.revision);
      revision(body.expectedWorkspaceRevision,w.revision);
      if (w.transition && (w.transition.id!==key || w.transition.requestHash!==requestHash || w.transition.path!==path))
        throw new ApiError('TRANSITION_BLOCKED','A different Workspace transition is pending.',409);
      if (!w.transition) {
        if (this.catalog.bindingBlocked(w.id) || this.db.get('reservation/'+w.binding.generatorId))
          throw new ApiError('TRANSITION_BLOCKED','Settle old dispatched effects before Connector upgrade.',409);
        this.cleanup();
        if (this.catalog.count('idempotency')>=1024) throw new ApiError('QUOTA_EXCEEDED','Management idempotency budget reached.',429);
        if (w.binding.browserInstallationId!==core.browserInstallationId)
          throw new ApiError('BINDING_MISMATCH','Legacy Binding belongs to a different installation.',409);
        w.transitionSerial=nextGeneration(w.transitionSerial??0);
        w.transition={id:key,requestHash,path,startedAt:Date.now(),serial:w.transitionSerial};
        this.db.put('workspace/'+w.id,w);
      }
      return {current:w} as const;
    });
    if ('receipt' in started && started.receipt) return started.receipt.result;
    const before=started.current!;
    await rpc(workspace(this.env,before.id),'/internal/settle-transition',{
      workspaceId:before.id,transitionId:key,serial:before.transition!.serial,
      epoch:before.epoch,bindingRevision:before.bindingRevision,
    });
    return this.db.transaction(()=>{
      const core=this.auth(authHash);
      const receipt=previous();
      if (receipt) return receipt.result;
      const a=this.getAgent(connectorId),w=this.getWorkspace(before.id);
      revision(body.expectedRevision,a.revision);
      revision(body.expectedWorkspaceRevision,w.revision);
      if (a.contractVersion!==undefined || a.suspended || a.workspaceId!==w.id || w.agentId!==a.id ||
          w.transition?.id!==key || w.transition.requestHash!==requestHash || w.transition.aborting || w.epoch!==before.epoch ||
          w.bindingRevision!==before.bindingRevision || !w.binding ||
          this.catalog.bindingBlocked(w.id) || this.db.get('reservation/'+w.binding.generatorId))
        throw new ApiError('TRANSITION_BLOCKED','Matching v1 scope did not remain settled.',409);
      const bindingOwner=this.db.get<{workspaceId:string}|undefined>(bindingOwnerKey(w.binding.generatorId));
      if (bindingOwner && bindingOwner.workspaceId!==w.id)
        throw new ApiError('TAB_BUSY','Another v2 Workspace owns this Generator.',409);
      const retainedPermissions=w.permissions.filter(permission=>permission!=='READ_RESOURCES' &&
        !['CREATE','RENAME','DUPLICATE','LISTING','DELETE','MEDIA','UPLOAD_PUBLIC','PRODUCTION_READ','PRODUCTION_RESTORE','EXPORT_ARTIFACT'].includes(permission));
      w.permissions=permissionCeiling(retainedPermissions);
      w.contractVersion=2;
      w.connectorId=a.id;
      w.assignmentGeneration=1;
      w.bindingGeneration=nextGeneration(w.bindingRevision);
      w.bindingRevision=w.bindingGeneration;
      w.epoch=nextGeneration(w.epoch);
      w.revision=nextGeneration(w.revision);
      w.permissionRevision=1;
      delete w.transition;
      delete w.agentId;
      a.contractVersion=2;
      a.workspaceId='';
      a.revision=nextGeneration(a.revision);
      a.permissionCeiling=w.permissions;
      initializeAssignments(this.db,a.id);
      changeAssignmentIndex(this.db,a.id,w.id,true);
      this.revokeWorkspace(w.id);
      this.db.put(bindingOwnerKey(w.binding.generatorId),{workspaceId:w.id});
      this.db.put('workspace/'+w.id,w);
      this.db.put('agent/'+a.id,a);
      core.schemaVersion=3;
      core.assignmentContractVersion=2;
      const result={connector:a,workspace:w,reauthorizationRequired:true};
      this.db.put(resultKey,{hash:requestHash,result,expires:Date.now()+86_400_000});
      this.bump(core);
      return result;
    });
  }
  private assertManagementKey(key: string): void {
    if (!/^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.test(key))
      throw new ApiError('INVALID_INPUT', 'Use a randomly generated management key.');
  }
  private async abortBindingChange(authHash: string, workspaceId: string, key: string, requestHash: string,
    body: Record<string, unknown>): Promise<unknown> {
    fields(body, ['expectedRevision', 'transitionId']);
    const transitionId = id(body.transitionId, 'transitionId');
    const resultKey = 'idempotency/' + key;
    const prior = () => {
      const receipt = this.db.get<{hash: string; result: unknown; expires: number} | undefined>(resultKey);
      if (!receipt || receipt.expires <= Date.now()) return undefined;
      if (receipt.hash !== requestHash) throw new ApiError('IDEMPOTENCY_CONFLICT', 'Management key belongs to a different request.', 409);
      return receipt;
    };
    const started = this.db.transaction(() => {
      const core = this.auth(authHash);
      if (this.env.DEVELOPMENT_CONTRACT_V2_ENABLED !== 'true')
        throw new ApiError('UPGRADE_REQUIRED','The v2 assignment contract is disabled.',409);
      const receipt = prior();
      if (receipt) return { receipt } as const;
      const w = this.getWorkspace(workspaceId);
      revision(body.expectedRevision, w.revision);
      if (!w.transition || w.transition.id !== transitionId)
        throw new ApiError('NOT_FOUND', 'Transition is unavailable.', 404);
      if (!w.transition.aborting) {
        this.cleanup();
        if (this.catalog.count('idempotency') >= 1024)
          throw new ApiError('QUOTA_EXCEEDED', 'Management idempotency budget reached.', 429);
        w.transition.aborting = true;
        this.db.put('workspace/' + w.id, w);
      }
      return { current: w } as const;
    });
    if ('receipt' in started && started.receipt) return started.receipt.result;
    const current = started.current!;
    await rpc(workspace(this.env, workspaceId), '/internal/settle-transition', {
      workspaceId, transitionId, serial: current.transition!.serial, abort: true,
      epoch: current.epoch, bindingRevision: current.bindingRevision,
    });
    return this.db.transaction(() => {
      const core = this.auth(authHash);
      if (this.env.DEVELOPMENT_CONTRACT_V2_ENABLED !== 'true')
        throw new ApiError('UPGRADE_REQUIRED','The v2 assignment contract is disabled.',409);
      const receipt = prior();
      if (receipt) return receipt.result;
      const w = this.getWorkspace(workspaceId);
      if (w.transition?.id !== transitionId || !w.transition.aborting ||
          w.epoch !== current.epoch || w.bindingRevision !== current.bindingRevision)
        throw new ApiError('TRANSITION_BLOCKED', 'Transition fence changed.', 409);
      if (this.catalog.bindingBlocked(w.id) || (w.binding && this.db.get('reservation/' + w.binding.generatorId)))
        throw new ApiError('TRANSITION_BLOCKED', 'Reconcile the existing effect before cancelling the transition.', 409);
      delete w.transition;
      w.revision = nextGeneration(w.revision);
      this.db.put('workspace/' + w.id, w);
      this.db.put(resultKey, { hash: requestHash, result: w, expires: Date.now() + 86_400_000 });
      this.bump(core);
      return w;
    });
  }
  private validateTransition(w: WorkspaceRecord, action: BindingAction, input: TransitionInput, c: Core): void {
    const current = requireAssignment(w);
    revision(input.expectedRevision, current.revision);
    if (current.connectorId)
      revision(input.expectedConnectorRevision, this.getAgent(current.connectorId).revision);
    else if (input.expectedConnectorRevision !== undefined)
      throw new ApiError('INVALID_INPUT', 'Workspace has no current Connector.');
    if (action === 'assign' && current.connectorId)
      throw new ApiError('CONFLICT', 'Workspace already has a Connector.', 409);
    if ((action === 'transfer' || action === 'unassign') && !current.connectorId)
      throw new ApiError('CONFLICT', 'Workspace has no assigned Connector.', 409);
    if (input.connectorId) {
      const target = this.getAgent(input.connectorId);
      if (target.contractVersion !== 2 || target.suspended || target.id === current.connectorId)
        throw new ApiError('SCOPE_DENIED', 'Destination Connector is unavailable.', 403);
      revision(input.expectedDestinationConnectorRevision, target.revision);
    }
    if (input.retainBinding && (!current.binding || canonical(input.binding) !== canonical(current.binding)))
      throw new ApiError('BINDING_MISMATCH', 'Retained Binding must match the verified editor.', 409);
    if (input.binding && input.binding.browserInstallationId !== c.browserInstallationId)
      throw new ApiError('BINDING_MISMATCH', 'Destination editor installation differs.', 409);
    if (input.binding) {
      const generatorId = input.binding.generatorId;
      const owner = this.db.get<{workspaceId: string} | undefined>(bindingOwnerKey(generatorId));
      const reservation = this.db.get<{workspaceId: string} | undefined>('reservation/' + generatorId);
      if ((owner && owner.workspaceId !== current.id) || (reservation && reservation.workspaceId !== current.id))
        throw new ApiError('TAB_BUSY', 'Destination Generator is already reserved.', 409);
      // Existing v1 bindings predate the owner record. Inspect bounded
      // management pages before first publication; dispatch never scans them.
      for (let offset = 0; offset < 1000; offset += 100) {
        const keys = this.catalog.page('workspace', offset, Date.now());
        for (const key of keys) {
          const other = this.db.get<WorkspaceRecord>(key);
          if (other.id !== current.id && other.binding?.generatorId === generatorId)
            throw new ApiError('TAB_BUSY', 'Destination Generator is already bound.', 409);
        }
        if (keys.length < 100) break;
        if (offset === 900)
          throw new ApiError('LIMIT_EXCEEDED', 'Cannot verify all existing Generator bindings.', 409);
      }
    }
  }
  private async changeBinding(
    authHash: string, path: string, workspaceId: string, action: BindingAction, key: string,
    requestHash: string, body: Record<string, unknown>,
  ): Promise<unknown> {
    const input = parseTransitionInput(action, body);
    const proofDigest = input.bindingProof ? await digest(input.bindingProof) : undefined;
    const resultKey = 'idempotency/' + key;
    const priorReceipt = () => {
      const receipt = this.db.get<{hash: string; result: unknown; expires: number} | undefined>(resultKey);
      if (!receipt || receipt.expires <= Date.now()) return undefined;
      if (receipt.hash !== requestHash)
        throw new ApiError('IDEMPOTENCY_CONFLICT', 'Management key belongs to a different request.', 409);
      return receipt;
    };
    const started = this.db.transaction(() => {
      const core = this.auth(authHash);
      this.requireDevelopmentContract(core);
      const receipt = priorReceipt();
      if (receipt) return { receipt } as const;
      const current = requireAssignment(this.getWorkspace(workspaceId));
      if (current.transition) {
        if (current.transition.aborting)
          throw new ApiError('TRANSITION_BLOCKED', 'Transition cancellation is awaiting settlement.', 409);
        if (current.transition.id !== key || current.transition.path !== path)
          throw new ApiError('TRANSITION_BLOCKED', 'Another transition is awaiting reconciliation.', 409);
        if (current.transition.requestHash !== requestHash)
          throw new ApiError('IDEMPOTENCY_CONFLICT', 'Management key belongs to a different transition.', 409);
        return { current } as const;
      }
      this.validateTransition(current, action, input, core);
      if (current.binding && this.db.get<{operatorRestore?: boolean}>(
          'reservation/' + current.binding.generatorId)?.operatorRestore)
        throw new ApiError('TRANSITION_BLOCKED', 'The exact Operator restore must settle before the Binding changes.', 409);
      if (current.binding && !input.acknowledgeDirty &&
          !(current.observation?.epoch === current.epoch && current.observation.dirty === false &&
            current.observation.observedAt + 60_000 > Date.now()))
        throw new ApiError('APPROVAL_REQUIRED', 'Confirm leaving the current draft in place.', 409);
      if (input.binding) {
        const proof = this.db.get<EditorProof | undefined>(bindingProofKey(current.id));
        if (!proof || proof.digest !== proofDigest || proof.expiresAt <= Date.now() ||
            proof.credentialEpoch !== core.credentialEpoch || proof.workspaceRevision !== current.revision ||
            canonical(proof.binding) !== canonical(input.binding))
          throw new ApiError('BINDING_MISMATCH', 'Destination editor proof expired or changed.', 409);
      }
      this.cleanup();
      if (this.catalog.count('idempotency') >= 1024)
        throw new ApiError('QUOTA_EXCEEDED', 'Management idempotency budget reached.', 429);
      current.transitionSerial = nextGeneration(current.transitionSerial ?? 0);
      current.transition = { id: key, requestHash, path, startedAt: Date.now(), serial: current.transitionSerial };
      this.db.put('workspace/' + current.id, current);
      return { current } as const;
    });
    if ('receipt' in started && started.receipt) return started.receipt.result;
    const current = started.current!;
    await rpc(workspace(this.env, workspaceId), '/internal/settle-transition', {
      workspaceId, transitionId: key, serial: current.transition!.serial,
      epoch: current.epoch, bindingRevision: current.bindingRevision,
    });
    return this.db.transaction(() => {
      const core = this.auth(authHash);
      this.requireDevelopmentContract(core);
      const receipt = priorReceipt();
      if (receipt) return receipt.result;
      const latest = requireAssignment(this.getWorkspace(workspaceId));
      if (latest.transition?.id !== key || latest.transition.requestHash !== requestHash || latest.transition.aborting ||
          latest.epoch !== current.epoch || latest.bindingRevision !== current.bindingRevision)
        throw new ApiError('TRANSITION_BLOCKED', 'Transition fence changed.', 409);
      this.validateTransition(latest, action, input, core);
      if (this.catalog.bindingBlocked(latest.id) ||
          (latest.binding && this.db.get('reservation/' + latest.binding.generatorId)))
        throw new ApiError('TRANSITION_BLOCKED', 'Reconcile the exact old effect before retrying this transition.', 409);
      const previousBinding = latest.binding;
      const previousConnector = latest.connectorId;
      if (action === 'assign' || action === 'transfer') latest.connectorId = input.connectorId!;
      if (action === 'unassign') latest.connectorId = null;
      if (action === 'rebind') latest.binding = input.binding!;
      if (action === 'detach' || action === 'unassign' || (action === 'transfer' && !input.retainBinding))
        latest.binding = null;
      if (previousConnector !== latest.connectorId) {
        if (previousConnector) changeAssignmentIndex(this.db, previousConnector, latest.id, false);
        if (latest.connectorId) changeAssignmentIndex(this.db, latest.connectorId, latest.id, true);
        latest.assignmentGeneration = nextGeneration(latest.assignmentGeneration);
      }
      if (previousBinding && previousBinding.generatorId !== latest.binding?.generatorId)
        this.db.delete(bindingOwnerKey(previousBinding.generatorId));
      if (latest.binding) this.db.put(bindingOwnerKey(latest.binding.generatorId), { workspaceId });
      latest.bindingGeneration = nextGeneration(latest.bindingGeneration);
      latest.bindingRevision = latest.bindingGeneration;
      latest.epoch = nextGeneration(latest.epoch);
      latest.revision = nextGeneration(latest.revision);
      delete latest.observation;
      delete latest.transition;
      delete latest.recoveryBinding;
      this.db.delete(bindingProofKey(latest.id));
      this.db.put('workspace/' + latest.id, latest);
      this.db.put(resultKey, { hash: requestHash, result: latest, expires: Date.now() + 86_400_000 });
      this.bump(core);
      return latest;
    });
  }
  private authorize(b: Record<string, unknown>): {
    workspace: WorkspaceRecord;
    grant: GrantRecord;
    agent: AgentRecord;
    policyRevision?: number;
  } {
    const props = b.props as AuthProps;
    if (props?.contractVersion === 2) {
      const { agent, grant, core } = this.authenticateConnector(b);
      const w = resolveTarget(this.db, agent.id, b.target);
      if (w.transition && b.resultAccess !== true)
        throw new ApiError('TRANSITION_BLOCKED', 'Workspace is changing its Binding or Assignment.', 409);
      if ((core.paused || w.paused) && b.resultAccess !== true)
        throw new ApiError('PAUSED', 'Execution is paused.', 403);
      this.requireToolPermissions(b, w, grant);
      return { workspace: w, grant, agent, policyRevision: core.policyRevision };
    }
    if (!props || props.contractVersion !== undefined || b.target !== undefined)
      throw new ApiError("AUTH_REQUIRED", "Grant context required.", 401);
    const c = this.core(),
      g = this.db.get<GrantRecord>("grant/" + id(props.grantId));
    if (!g || g.contractVersion !== undefined || !grantIsActive(g))
      throw new ApiError("REVOKED", "Grant is revoked or expired.", 403);
    const a = this.getAgent(g.agentId),
      w = this.getWorkspace(g.workspaceId);
    if (c.paused || w.paused)
      throw new ApiError("PAUSED", "Execution is paused.", 403);
    if (
      props.agentId !== a.id ||
      b.agentId !== a.id ||
      props.workspaceId !== w.id ||
      props.bindingRevision !== w.bindingRevision ||
      g.bindingRevision !== w.bindingRevision ||
      a.workspaceId !== w.id ||
      a.contractVersion !== undefined ||
      w.contractVersion !== undefined ||
      a.suspended ||
      w.transition ||
      !w.binding
    )
      throw new ApiError(
        "REVOKED",
        "Assignment, binding or execution policy changed.",
        403,
      );
    this.requireToolPermissions(b, w, g);
    return { workspace: w, grant: g, agent: a };
  }
  private requireToolPermissions(b: Record<string, unknown>, w: WorkspaceRecord, g: GrantRecord): void {
    const needed = Array.isArray(b.permissions) ? b.permissions : [];
    if (
      !needed.every(
        (p) =>
          typeof p === "string" &&
          g.permissions.includes(p) &&
          w.permissions.includes(p),
      )
    )
      throw new ApiError(
        "SCOPE_DENIED",
        "Required permission was not granted.",
        403,
      );
    if (
      b.mutating === true &&
      [
        "SAVE",
        "CREATE",
        "RENAME",
        "DUPLICATE",
        "LISTING",
        "DELETE",
        "UPLOAD_PUBLIC",
        "MEDIA",
        "PRODUCTION_RESTORE",
      ].some((p) => needed.includes(p)) &&
      this.env.PROVIDER_WRITES_ENABLED !== "true" &&
      !permitsHarNativeAction(this.env,b.tool,needed)
    )
      throw new ApiError(
        "UNSUPPORTED_INTERFACE",
        "External provider effects remain disabled until live adapter acceptance.",
        409,
      );
  }
  private requireDevelopmentContract(core: Core): void {
    if (this.env.DEVELOPMENT_CONTRACT_V2_ENABLED !== 'true' || core.assignmentContractVersion !== 2)
      throw new ApiError('UPGRADE_REQUIRED', 'The v2 assignment contract is disabled.', 409);
  }
  private authenticateConnector(b: Record<string, unknown>, renewal = false): { agent: AgentRecord; grant: GrantRecord; core: Core } {
    const props = b.props as AuthProps | undefined;
    const core = this.core();
    if (!renewal) this.requireDevelopmentContract(core);
    else if (core.assignmentContractVersion !== 2)
      throw new ApiError('UPGRADE_REQUIRED', 'Connector authority is unavailable.', 409);
    if (!props || props.contractVersion !== 2)
      throw new ApiError('AUTH_REQUIRED', 'A v2 Grant is required.', 401);
    const grant = this.db.get<GrantRecord | undefined>('grant/' + id(props.grantId));
    if (!grant || grant.contractVersion !== 2 || !grantIsActive(grant) ||
        grant.agentId !== props.agentId || grant.agentId !== b.agentId ||
        grant.credentialEpoch !== core.credentialEpoch || grant.credentialEpoch !== props.credentialEpoch ||
        grant.clientId !== props.clientId || grant.audience !== props.audience ||
        (b.authenticatedClientId !== undefined && b.authenticatedClientId !== grant.clientId) ||
        (b.resource !== undefined && b.resource !== grant.audience) ||
        props.workspaceId !== '' || props.bindingRevision !== 0 ||
        grant.workspaceId !== '' || grant.bindingRevision !== 0)
      throw new ApiError('REVOKED', 'Connector Grant is unavailable.', 403);
    const agent = this.getAgent(grant.agentId);
    if (agent.contractVersion !== 2 || agent.endpoint !== grant.audience ||
        agent.endpoint !== core.issuer + '/mcp/' + agent.id)
      throw new ApiError('REVOKED', 'Connector Grant is unavailable.', 403);
    if (agent.suspended && !renewal)
      throw new ApiError('PAUSED', 'Connector execution is suspended; authorization is retained.', 403);
    const ceiling = permissionCeiling(agent.permissionCeiling);
    const granted = permissionCeiling(grant.permissions);
    return { agent, grant: { ...grant, permissions: granted.filter((value) => ceiling.includes(value)) }, core };
  }
  private verifyApprovalScope(approval: Approval, core: Core): void {
    const connector = this.getAgent(approval.agentId);
    let matches = false;
    if (approval.contractVersion === 2 && connector.contractVersion === 2) {
      this.requireDevelopmentContract(core);
      matches = connector.endpoint === approval.audience &&
        connector.revision === approval.connectorRevision &&
        core.credentialEpoch === approval.credentialEpoch &&
        canonical(permissionCeiling(connector.permissionCeiling)) === canonical(approval.permissionSnapshot);
    } else if (approval.contractVersion === undefined && connector.contractVersion === undefined) {
      const w = this.getWorkspace(approval.workspaceId);
      matches = !!w.binding && !w.paused && !w.transition && w.contractVersion === undefined &&
        w.id === connector.workspaceId && w.bindingRevision === approval.bindingRevision &&
        canonical(w.permissions) === canonical(approval.permissionSnapshot);
    }
    if (!matches || connector.suspended || core.paused || core.policyRevision !== approval.policyRevision)
      throw new ApiError('REVOKED', 'Connector approval no longer matches current authorization.', 403);
  }
  private async readAdmin(path: string, url: URL): Promise<Response> {
    // OAuth, Workspace and credential management must not materialize, clone,
    // hash or validate the entire Resource library on every admin GET. The
    // Resource endpoints initialize/validate their library independently.
    const c = this.core(),
      prefix = "/api/v1/admin/";
    if(path===prefix+"storage")return json({mode:this.env.CANONICAL_STORAGE_MODE??"legacy",
      revision:c.revision,activity:this.catalog.activityMigrationStatus(),resources:resourceStorageStatus(this.db),
      rollback:"After any native cutover use this compatible candidate; old binaries cannot read new authority."});
    if (path === prefix + "diagnostics")
      return json({
        schemaVersion: 1,
        gatewayVersion: VERSION,
        events: readOAuthDiagnostics(this.db),
        incidents: incidentSummary(),
      });
    if (path === prefix + "state")
      return json({
        revision: c.revision,
        policyRevision: c.policyRevision,
        assignmentContractVersion: c.assignmentContractVersion ?? 1,
        rollout: {
          developmentContractV2Enabled: this.env.DEVELOPMENT_CONTRACT_V2_ENABLED === 'true',
          developmentContractV2ExecutionEnabled: this.env.DEVELOPMENT_CONTRACT_V2_EXECUTION_ENABLED === 'true',
          canonicalStorageMode: this.env.CANONICAL_STORAGE_MODE ?? 'legacy',
          pushNotificationsEnabled: this.env.PUSH_NOTIFICATIONS_ENABLED === 'true',
          binaryPayloadsEnabled: this.env.BINARY_PAYLOADS_ENABLED === 'true',
          admissionBudgetEnabled: this.env.ADMISSION_BUDGET_ENABLED === 'true',
          actualPixelCapture: 'UNSUPPORTED_INTERFACE',
          accountQuotaKnown: false,
          oauthGrantPersistence: c.assignmentContractVersion===2?'UNTIL_REVOKED':'LEGACY_FINITE',
          oauthAccessTokenTtlSeconds: c.assignmentContractVersion===2 || this.env.DEVELOPMENT_CONTRACT_V2_ENABLED==='true' ?
            persistentAccessTokenTTL(this.env.OAUTH_ACCESS_TOKEN_TTL_SECONDS) : 900,
          oauthAccessTokenQualification: this.env.OAUTH_ACCESS_TOKEN_TTL_SECONDS===undefined?
            'DEFAULT_BROWSER_TIMER_SAFE' :
            persistentAccessTokenTTL(this.env.OAUTH_ACCESS_TOKEN_TTL_SECONDS)>DEFAULT_ACCESS_TOKEN_TTL_SECONDS?
            'EXPERIMENTAL_EXTERNAL_CLIENT_REQUIRED':'EXPLICIT_TIMER_SAFE',
        },
        paused: c.paused,
        paired: c.paired,
        version: VERSION,
        schemaVersion: 1,
        limits: {
          workspaces: configuredBudget(
            this.env.REGISTRY_WORKSPACE_BUDGET,
            1000,
          ),
          grants: configuredBudget(this.env.REGISTRY_GRANT_BUDGET, 1000),
          oauthRegistrationsPerHour: configuredBudget(
            this.env.OAUTH_REGISTRATIONS_PER_HOUR,
            100,
            10000,
          ),
          workspaceQueue: 8,
          leaseMs: 180000,
          pollMs: 25000,
          inlineMcpBytes: 262144,
          workspaceTransientBytes: 8 * 1024 * 1024,
        },
        libraryRevision: resourceLibraryIsNative(this.db)?resourceLibraryRevision(this.db):this.catalog.libraryRevision(),
        workspaces: this.catalog.count("workspace"),
        agents: this.catalog.count("agent"),
      });
    if (path === prefix + 'connectors') {
      if (this.env.DEVELOPMENT_CONTRACT_V2_ENABLED !== 'true')
        throw new ApiError('UPGRADE_REQUIRED', 'The v2 assignment contract is disabled.', 409);
      const offset = Number(url.searchParams.get('cursor') ?? 0);
      if (!Number.isSafeInteger(offset) || offset < 0)
        throw new ApiError('INVALID_INPUT', 'Invalid Connector cursor.');
      const keys = this.catalog.page('agent', offset, Date.now());
      const items = keys.map((key) => this.db.get<AgentRecord>(key)).map((connector) => ({
        ...connector,
        contractVersion: connector.contractVersion ?? 1,
        assignmentCount: connector.contractVersion === 2 ? assignmentCount(this.db, connector.id) : 1,
      }));
      return json({ items, cursor: keys.length === 100 ? String(offset + 100) : null, revision: c.revision });
    }
    const receipt = /^\/api\/v1\/admin\/receipts\/([a-z0-9-]{32,36})$/.exec(path);
    if (receipt) {
      const row = this.db.get<{result: unknown; expires: number} | undefined>('idempotency/' + receipt[1]);
      if (!row || row.expires <= Date.now()) throw new ApiError('NOT_FOUND', 'Management receipt unavailable.', 404);
      return json({ result: row.result });
    }
    const entity =
      /^\/api\/v1\/admin\/(workspaces|agents)\/([a-zA-Z0-9_-]+)$/.exec(path);
    if (entity)
      return json(
        entity[1] === "workspaces"
          ? this.getWorkspace(entity[2]!)
          : this.getAgent(entity[2]!),
      );
    const lists: Record<string, string> = {
      workspaces: "workspace/",
      agents: "agent/",
      grants: "grant/",
      approvals: "approval/",
    };
    const list = lists[path.slice(prefix.length)];
    if (list) {
      const offset = Number(url.searchParams.get("cursor") ?? 0);
      if (!Number.isSafeInteger(offset) || offset < 0)
        throw new ApiError("INVALID_INPUT", "Invalid cursor.");
      const items = this.catalog.page(list.slice(0,-1) as "workspace"|"agent"|"grant"|"approval",offset,Date.now())
        .map((k) => this.db.get<Record<string, unknown>>(k))
        .map((v) => {
          const { handleHash: _, request: __, completionRedirect: ___, ...safe } = v;
          return safe;
        });
      return json({
        items,
        revision: c.revision,
        cursor: items.length === 100 ? String(offset + 100) : null,
      });
    }
    if (path === prefix + "activity") {
      return json(this.catalog.activityPage(url.searchParams.get("cursor"),
        url.searchParams.get("status"),url.searchParams.get("workspaceId"),c.revision));
    }
    throw new ApiError("NOT_FOUND", "Route not found.", 404);
  }
  private writeAdmin(
    path: string,
    b: Record<string, unknown>,
    c: Core,
  ): unknown {
    const prefix = "/api/v1/admin/";
    if(path===prefix+"storage/restart-activity") {
      fields(b,["expectedRevision"]);revision(b.expectedRevision,c.revision);
      return this.catalog.restartActivityMigration();
    }
    if(path===prefix+"storage/step") {
      fields(b,["expectedRevision"]);revision(b.expectedRevision,c.revision);
      return this.advanceStorage();
    }
    if (path === prefix + 'connectors') {
      if (this.env.DEVELOPMENT_CONTRACT_V2_ENABLED !== 'true')
        throw new ApiError('UPGRADE_REQUIRED', 'The v2 assignment contract is disabled.', 409);
      fields(b, ['expectedRevision', 'label', 'permissionCeiling']);
      revision(b.expectedRevision, c.revision);
      if (this.catalog.count('agent') >= 50)
        throw new ApiError('QUOTA_EXCEEDED', 'Connector count exceeds installation budget.', 429);
      const connectorId = crypto.randomUUID();
      const connector: AgentRecord = {
        id: connectorId, label: str(b.label, 'label'), revision: 1, suspended: false,
        endpoint: c.issuer + '/mcp/' + connectorId, workspaceId: '', contractVersion: 2,
        permissionCeiling: permissionCeiling(b.permissionCeiling ?? v2DefaultPermissions),
      };
      initializeAssignments(this.db, connectorId);
      this.db.put('agent/' + connectorId, connector);
      c.schemaVersion = 3;
      c.assignmentContractVersion = 2;
      return { ...connector, assignmentCount: 0 };
    }
    const connectorEdit = /^\/api\/v1\/admin\/connectors\/([A-Za-z0-9_-]+)$/.exec(path);
    if (connectorEdit) {
      this.requireDevelopmentContract(c);
      fields(b, ['expectedRevision', 'label', 'suspended', 'permissionCeiling']);
      const connector = this.getAgent(connectorEdit[1]!);
      if (connector.contractVersion !== 2) throw new ApiError('UPGRADE_REQUIRED', 'Connector still uses v1.', 409);
      revision(b.expectedRevision, connector.revision);
      if (b.label !== undefined) connector.label = str(b.label, 'label');
      if (b.permissionCeiling !== undefined) connector.permissionCeiling = permissionCeiling(b.permissionCeiling);
      if (b.suspended !== undefined) {
        if (typeof b.suspended !== 'boolean') throw new ApiError('INVALID_INPUT', 'suspended must be boolean.');
        connector.suspended = b.suspended;
      }
      connector.revision = nextGeneration(connector.revision);
      this.db.put('agent/' + connector.id, connector);
      return { ...connector, assignmentCount: assignmentCount(this.db, connector.id) };
    }
    if (path === prefix + "workspaces") {
      fields(b, ["label", "permissions", "contractVersion", "connectorId", "expectedConnectorRevision"]);
      const isV2 = b.contractVersion === 2;
      if (!isV2 && (b.contractVersion !== undefined || b.connectorId !== undefined || b.expectedConnectorRevision !== undefined))
        throw new ApiError('INVALID_INPUT', 'Assignment fields require contractVersion 2.');
      if (isV2 && this.env.DEVELOPMENT_CONTRACT_V2_ENABLED !== 'true')
        throw new ApiError('UPGRADE_REQUIRED','The v2 assignment contract is disabled.',409);
      if (
        this.catalog.count("workspace") >=
        configuredBudget(this.env.REGISTRY_WORKSPACE_BUDGET, isV2 ? 50 : 1000)
      )
        throw new ApiError(
          "QUOTA_EXCEEDED",
          "Workspace count exceeds installation budget.",
          429,
        );
      const w: WorkspaceRecord = {
        id: crypto.randomUUID(),
        label: str(b.label, "label"),
        revision: 1,
        bindingRevision: 0,
        permissions: isV2 ? permissionCeiling(b.permissions ?? v2DefaultPermissions) :
          b.permissions === undefined
            ? [...DEFAULT_PERMISSIONS]
            : permissions(b.permissions),
        paused: false,
        binding: null,
        epoch: 0,
      };
      if (isV2) {
        c.schemaVersion=3;
        c.assignmentContractVersion=2;
        w.contractVersion = 2;
        w.connectorId = null;
        w.assignmentGeneration = 0;
        w.bindingGeneration = 0;
        w.permissionRevision = 1;
        if (b.connectorId !== undefined) {
          const connector = this.getAgent(id(b.connectorId));
          if (connector.contractVersion !== 2 || connector.suspended)
            throw new ApiError('SCOPE_DENIED', 'Connector is unavailable for assignment.', 403);
          revision(b.expectedConnectorRevision, connector.revision);
          changeAssignmentIndex(this.db, connector.id, w.id, true);
          w.connectorId = connector.id;
          w.assignmentGeneration = 1;
        } else if (b.expectedConnectorRevision !== undefined) {
          throw new ApiError('INVALID_INPUT', 'Connector revision requires a Connector.');
        }
      }
      this.db.put("workspace/" + w.id, w);
      return w;
    }
    if (path === prefix + "agents") {
      fields(b, ["label", "workspaceId"]);
      const w = this.getWorkspace(id(b.workspaceId));
      if (w.agentId || w.contractVersion !== undefined)
        throw new ApiError("CONFLICT", "Workspace already has an Agent.", 409);
      const a: AgentRecord = {
        id: crypto.randomUUID(),
        label: str(b.label, "label"),
        workspaceId: w.id,
        revision: 1,
        suspended: false,
        endpoint: c.issuer + "/mcp/",
      };
      a.endpoint += a.id;
      w.agentId = a.id;
      w.revision++;
      this.db.put("agent/" + a.id, a);
      this.db.put("workspace/" + w.id, w);
      return a;
    }
    const resolutionMatch =
      /^\/api\/v1\/admin\/workspaces\/([a-zA-Z0-9_-]+)\/resolve$/.exec(path);
    if (resolutionMatch) {
      fields(b, [
        "expectedRevision",
        "operationId",
        "epoch",
        "bindingRevision",
        "observedRevision",
        "observedDigest",
        "evidence",
        "acknowledgeUncertainty",
      ]);
      const w = this.getWorkspace(resolutionMatch[1]!);
      const operationId = id(b.operationId);
      const prior = this.db.get<{
        resolvedByOperator:boolean;observedRevision:string;observedDigest:string;
        evidence:string;epoch?:number;bindingRevision?:number;
      }>("resolution/"+w.id+"/"+operationId);
      if(prior){
        // The Registry can commit before the Workspace DO acknowledges.
        // A lost acknowledgement must be repairable without incrementing
        // the epoch again or treating a second request as a new resolution.
        if(b.acknowledgeUncertainty!==true || prior.epoch!==b.epoch ||
           prior.bindingRevision!==b.bindingRevision ||
           prior.observedRevision!==b.observedRevision ||
           prior.observedDigest!==b.observedDigest || prior.evidence!==b.evidence)
          throw new ApiError("CONFLICT","Prior resolution differs; inspect authoritative state.",409);
        return {workspaceId:w.id,operationId,epoch:b.epoch,
          bindingRevision:b.bindingRevision,resolution:prior,workspaceRevision:w.revision};
      }
      revision(b.expectedRevision, w.revision);
      if (
        b.acknowledgeUncertainty !== true ||
        (b.bindingRevision !== w.bindingRevision &&
          b.bindingRevision !== w.recoveryBinding?.bindingRevision) ||
        !Number.isSafeInteger(b.epoch)
      )
        throw new ApiError(
          "APPROVAL_REQUIRED",
          "Exact binding and acknowledged uncertainty required.",
          409,
        );
      const observedRevision = str(b.observedRevision, "observedRevision", 256),
        observedDigest = str(b.observedDigest, "observedDigest", 64),
        evidence = str(b.evidence, "evidence", 512);
      if (!/^[a-f0-9]{64}$/.test(observedDigest))
        throw new ApiError(
          "INVALID_INPUT",
          "Observed source SHA-256 required.",
        );
      const resolution = {
        resolvedByOperator: true,
        observedRevision,
        observedDigest,
        evidence,
        epoch:b.epoch as number,bindingRevision:b.bindingRevision as number,
        timestamp: Date.now(),
      };
      w.epoch++;
      w.revision++;
      this.db.put("workspace/" + w.id, w);
      const resolutionBinding =
        w.recoveryBinding &&
        b.bindingRevision === w.recoveryBinding.bindingRevision
          ? w.recoveryBinding.binding
          : w.binding;
      if (resolutionBinding) {
        const key = "reservation/" + resolutionBinding.generatorId;
        const reserved = this.db.get<{ operationId: string }>(key);
        if (reserved?.operationId === operationId) this.db.delete(key);
      }
      this.db.put("resolution/" + w.id + "/" + operationId, resolution);
      this.catalog.resolveActivity(w.id,operationId,resolution);
      const noticeKey = "terminal-notice/" + w.id + "/" + operationId,
        notice = this.db.get<{
          phase: string;
          event?: Record<string, unknown>;
          expires: number;
        }>(noticeKey);
      if (notice?.event) {
        notice.event.resolution = resolution;
        notice.expires = Date.now() + 7 * 86400000;
        this.db.put(noticeKey, notice);
      }
      return {
        workspaceId: w.id,
        operationId,
        epoch: b.epoch,
        bindingRevision: b.bindingRevision,
        resolution,
        workspaceRevision: w.revision,
      };
    }
    if (path === prefix + "pause") {
      fields(b, ["expectedRevision", "paused"]);
      revision(b.expectedRevision, c.policyRevision);
      if (typeof b.paused !== "boolean")
        throw new ApiError("INVALID_INPUT", "paused must be boolean.");
      c.paused = b.paused;
      c.policyRevision++;
      return { paused: c.paused, policyRevision: c.policyRevision };
    }
    let m =
      /^\/api\/v1\/admin\/workspaces\/([a-zA-Z0-9_-]+)(?:\/(bind|detach))?$/.exec(
        path,
      );
    if (m) {
      const w = this.getWorkspace(m[1]!);
      if (m[2] && w.contractVersion === 2)
        throw new ApiError('UPGRADE_REQUIRED', 'Use the v2 binding transition for this Workspace.', 409);
      if (w.transition)
        throw new ApiError('TRANSITION_BLOCKED', 'Workspace transition is awaiting reconciliation.', 409);
      revision(b.expectedRevision, w.revision);
      if (
        m[2] &&
        w.binding &&
        this.db.get("reservation/" + w.binding.generatorId)
      )
        throw new ApiError(
          "EFFECT_UNKNOWN",
          "Wait for or reconcile the generator writer before changing its binding.",
          409,
        );
      if (
        m[2] &&
        this.catalog.bindingBlocked(w.id)
      )
        throw new ApiError(
          "EFFECT_UNKNOWN",
          "Settle or resolve every dispatched operation before changing the binding.",
          409,
        );
      if (m[2] === "bind") {
        fields(b, ["expectedRevision", "binding", "replace"]);
        const proposed = binding(b.binding);
        if (proposed.browserInstallationId !== c.browserInstallationId)
          throw new ApiError(
            "BINDING_MISMATCH",
            "Unknown browser installation.",
            409,
          );
        if (w.binding && !b.replace)
          throw new ApiError(
            "BINDING_MISMATCH",
            "Explicit replacement required.",
            409,
          );
        const reservation = this.db.get<{ workspaceId: string }>(
          "reservation/" + proposed.generatorId,
        );
        const owner = this.db.get<{ workspaceId: string }>(bindingOwnerKey(proposed.generatorId));
        if ((reservation && reservation.workspaceId !== w.id) || (owner && owner.workspaceId !== w.id))
          throw new ApiError(
            "TAB_BUSY",
            "Generator has an unresolved writer.",
            409,
          );
        w.binding = proposed;
        delete w.recoveryBinding;
        w.bindingRevision++;
        w.epoch++;
        this.revokeWorkspace(w.id);
      } else if (m[2] === "detach") {
        fields(b, ["expectedRevision"]);
        w.binding = null;
        w.bindingRevision++;
        w.epoch++;
        this.revokeWorkspace(w.id);
      } else {
        fields(b, ["expectedRevision", "label", "paused", "permissions"]);
        if (b.label !== undefined) w.label = str(b.label, "label");
        if (b.paused !== undefined) {
          if (typeof b.paused !== "boolean")
            throw new ApiError("INVALID_INPUT", "paused must be boolean.");
          w.paused = b.paused;
        }
        if (b.permissions !== undefined) {
          if (w.contractVersion === 2) {
            w.permissions = permissionCeiling(b.permissions);
            w.permissionRevision = nextGeneration(w.permissionRevision ?? 1);
          } else {
            w.permissions = permissions(b.permissions);
            this.revokeWorkspace(w.id);
          }
        }
      }
      w.revision++;
      this.db.put("workspace/" + w.id, w);
      return w;
    }
    m = /^\/api\/v1\/admin\/agents\/([a-zA-Z0-9_-]+)$/.exec(path);
    if (m) {
      fields(b, ["expectedRevision", "label", "suspended"]);
      const a = this.getAgent(m[1]!);
      if (a.contractVersion !== undefined)
        throw new ApiError('UPGRADE_REQUIRED', 'Use Connector management for this record.', 409);
      revision(b.expectedRevision, a.revision);
      if (b.label !== undefined) a.label = str(b.label, "label");
      if (b.suspended !== undefined) {
        if (typeof b.suspended !== "boolean")
          throw new ApiError("INVALID_INPUT", "suspended must be boolean.");
        a.suspended = b.suspended;
      }
      a.revision++;
      this.db.put("agent/" + a.id, a);
      return a;
    }
    m = /^\/api\/v1\/admin\/grants\/([a-zA-Z0-9_-]+)\/revoke$/.exec(path);
    if (m) {
      fields(b, ["expectedRevision"]);
      const g = this.db.get<GrantRecord>("grant/" + m[1]);
      if (!g) throw new ApiError("NOT_FOUND", "Grant not found.", 404);
      revision(b.expectedRevision, g.revision);
      g.state = "revoked";
      g.revokedAt = Date.now();
      g.revision++;
      this.db.put("grant/" + g.id, g);
      return g;
    }
    m = /^\/api\/v1\/admin\/approvals\/([a-zA-Z0-9_-]+)\/decision$/.exec(path);
    if (m) {
      fields(b, ["expectedRevision", "digest", "decision"]);
      const a = this.db.get<Approval>("approval/" + m[1]);
      if (!a) throw new ApiError("NOT_FOUND", "Approval not found.", 404);
      revision(b.expectedRevision, a.revision);
      if (
        a.state !== "pending" ||
        a.expiresAt <= Date.now() ||
        b.digest !== a.digest
      )
        throw new ApiError(
          "APPROVAL_REQUIRED",
          "Approval changed, expired or consumed.",
          409,
        );
      if (b.decision === "approve") {
        try { this.verifyApprovalScope(a, c); }
        catch (error) {
          if (error instanceof ApiError && [403, 404, 409].includes(error.status))
            throw new ApiError('APPROVAL_REQUIRED', 'Connector or policy changed; restart authorization.', 409);
          throw error;
        }
      }
      if (!["approve", "deny"].includes(String(b.decision)))
        throw new ApiError(
          "INVALID_INPUT",
          "Decision must be approve or deny.",
        );
      a.state = b.decision === "approve" ? "approved" : "denied";
      a.revision++;
      this.db.put("approval/" + a.id, a);
      const { handleHash: _, request: __, completionRedirect: ___, ...safe } = a;
      return safe;
    }
    throw new ApiError("NOT_FOUND", "Route not found.", 404);
  }
}
