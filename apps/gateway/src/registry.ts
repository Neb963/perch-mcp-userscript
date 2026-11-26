import { ResourceError } from "../../../packages/resource-library/src/index.js";
import type { DurableObjectState } from "@cloudflare/workers-types";
import {
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
  type Binding,
  type Env,
} from "./common.js";
import { SqlRecords } from "./sql.js";
import { resourceAdmin, resourceTool } from "./resources.js";
export interface WorkspaceRecord {
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
  id: string;
  label: string;
  workspaceId: string;
  revision: number;
  suspended: boolean;
  endpoint: string;
}
export interface GrantRecord {
  id: string;
  agentId: string;
  workspaceId: string;
  bindingRevision: number;
  permissions: string[];
  state: "active" | "revoked";
  clientId: string;
  expiresAt: number;
  revision: number;
}
interface Approval {
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
  effect?: {
    tool: string;
    argsDigest: string;
    epoch: number;
    sourceRevision?: string;
  };
}
interface Core {
  schemaVersion: 1;
  revision: number;
  policyRevision: number;
  paused: boolean;
  issuer: string | null;
  paired: boolean;
  adminHash?: string;
  executionHash?: string;
  browserInstallationId?: string;
  recoveryHash?: string;
  credentialEpoch: number;
}
export interface AuthProps {
  grantId: string;
  agentId: string;
  workspaceId: string;
  bindingRevision: number;
}
export class Registry {
  private db: SqlRecords;
  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {
    this.db = new SqlRecords(state.storage);
  }
  private core(): Core {
    const c = this.db.get<Core>("core", {
      schemaVersion: 1,
      revision: 1,
      policyRevision: 1,
      paused: false,
      issuer: this.env.ISSUER_URL ? origin(this.env.ISSUER_URL) : null,
      paired: false,
      credentialEpoch: 1,
    });
    if (c.schemaVersion !== 1)
      throw new ApiError(
        "INCOMPATIBLE_VERSION",
        "Registry schema is newer than this Worker; restore a compatible version.",
        409,
      );
    return c;
  }
  private cleanup(): void {
    const now = Date.now();
    for (const key of this.db.keys("approval/"))
      if (this.db.get<{ expiresAt: number }>(key).expiresAt < now)
        this.db.delete(key);
    for (const key of this.db.keys("grant/"))
      if (this.db.get<{ expiresAt: number }>(key).expiresAt < now)
        this.db.delete(key);
    for (const key of this.db.keys("permit/")) {
      const row = this.db.get<{ state: string; createdAt?: number }>(key);
      if (
        row.state === "terminal" &&
        row.createdAt !== undefined &&
        row.createdAt + 7 * 86400000 < now
      )
        this.db.delete(key);
    }
    for (const key of this.db.keys("terminal-notice/")) {
      const notice = this.db.get<{
        expires: number;
        phase: string;
        event?: { resolution?: unknown };
      }>(key);
      if (
        notice.expires < now &&
        (!["UNKNOWN", "PARTIAL"].includes(notice.phase) ||
          notice.event?.resolution)
      ) {
        this.db.delete(key);
        if (notice.event?.resolution)
          this.db.delete(key.replace("terminal-notice/", "resolution/"));
      }
    }
    for (const key of this.db.keys("idempotency/"))
      if (this.db.get<{ expires: number }>(key).expires < now)
        this.db.delete(key);
  }
  private bump(c: Core): void {
    c.revision++;
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
    for (const key of this.db.keys("grant/")) {
      const g = this.db.get<GrantRecord>(key);
      if (g.workspaceId === workspaceId && g.state === "active") {
        g.state = "revoked";
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
    try {
      return await this.route(request);
    } catch (error) {
      return errorResponse(
        error instanceof ResourceError
          ? new ApiError(
              error.code,
              error.message,
              error.code === "RESOURCE_NOT_FOUND" ? 404 : 409,
            )
          : error,
      );
    }
  }
  private async route(request: Request): Promise<Response> {
    const url = new URL(request.url),
      path = url.pathname;
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
        !Number.isInteger(b.status) || Number(b.status) < 200 || Number(b.status) > 599 ||
        !/^[a-f0-9-]{36}$/.test(String(b.traceId))
      ) throw new ApiError("INVALID_INPUT", "Invalid bounded diagnostic event.");
      this.db.transaction(() => {
        const now = Date.now(),
          budget = this.db.get<{ minute: number; count: number }>("diagnostic-budget", { minute: Math.floor(now / 60000), count: 0 }),
          minute = Math.floor(now / 60000),
          count = budget.minute === minute ? budget.count : 0;
        if (count >= 120) return;
        this.db.put("diagnostic-budget", { minute, count: count + 1 });
        const rows = this.db.get<Record<string, unknown>[]>("diagnostic-events", []);
        rows.push({ at: now, route, method, originClass, status: b.status, code, traceId: b.traceId });
        this.db.put("diagnostic-events", rows.filter((row) => Number(row.at) > now - 7 * 86400000).slice(-100));
      });
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
      return json({
        issuer: c.issuer,
        paired: c.paired,
        resources: this.db
          .keys("agent/")
          .map((k) => this.db.get<AgentRecord>(k))
          .filter((a) => !a.suspended)
          .map((a) => a.endpoint),
        version: VERSION,
        schemaVersion: 1,
      });
    }
    if (path === "/internal/health") {
      const c = this.core();
      return json({
        version: VERSION,
        schemaVersion: 1,
        paired: c.paired,
        configured: !!c.issuer,
        providerWritesEnabled: this.env.PROVIDER_WRITES_ENABLED === "true",
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
          w.binding = null;
          w.bindingRevision++;
          w.epoch++;
          w.revision++;
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
      const a = this.db
        .keys("agent/")
        .map((k) => this.db.get<AgentRecord>(k))
        .find((a) => a.endpoint === auth.resource && !a.suspended);
      if (!a) throw new ApiError("INVALID_TARGET", "Unknown Agent resource.");
      const w = this.getWorkspace(a.workspaceId);
      if (!w.binding)
        throw new ApiError(
          "BINDING_MISMATCH",
          "Attach the Workspace before authorization.",
          409,
        );
      if (w.paused || this.core().paused)
        throw new ApiError("PAUSED", "Execution is paused.", 403);
      const handle = randomSecret(),
        handleHash = await digest(handle),
        requestDigest = await digest(
          canonical({
            request: auth,
            bindingRevision: w.bindingRevision,
            permissions: w.permissions,
            policyRevision: this.core().policyRevision,
          }),
        ),
        approvalId = crypto.randomUUID();
      const approval: Approval = {
        id: approvalId,
        code: crypto.randomUUID().slice(0, 8).toUpperCase(),
        kind: "oauth",
        digest: requestDigest,
        agentId: a.id,
        workspaceId: w.id,
        clientId: String(auth.clientId),
        redirectUri: String(auth.redirectUri),
        scope: Array.isArray(auth.scope) ? (auth.scope as string[]) : [],
        expiresAt: Date.now() + 300000,
        state: "pending",
        revision: 1,
        bindingRevision: w.bindingRevision,
        permissionSnapshot: [...w.permissions],
        policyRevision: this.core().policyRevision,
        request: auth,
        handleHash,
      };
      this.db.transaction(() => {
        const c = this.core();
        this.cleanup();
        if (
          this.db
            .keys("approval/")
            .filter((k) => this.db.get<Approval>(k).expiresAt > Date.now())
            .length >= 100
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
        workspaceLabel: w.label,
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
          if (a.state !== "approved") return { state: a.state };
          const w = this.getWorkspace(a.workspaceId),
            agent = this.getAgent(a.agentId);
          if (
            !w.binding ||
            w.paused ||
            agent.suspended ||
            this.core().paused ||
            w.bindingRevision !== a.bindingRevision ||
            canonical(w.permissions) !== canonical(a.permissionSnapshot) ||
            this.core().policyRevision !== a.policyRevision
          )
            throw new ApiError(
              "REVOKED",
              "Workspace is unavailable for authorization.",
              403,
            );
          a.state = "consumed";
          this.db.put("approval/" + a.id, a);
          this.cleanup();
          if (
            this.db.keys("grant/").length >=
            configuredBudget(this.env.REGISTRY_GRANT_BUDGET, 1000)
          )
            throw new ApiError(
              "QUOTA_EXCEEDED",
              "Grant budget reached; revoke and wait for expired grants to retire.",
              429,
            );
          const g: GrantRecord = {
            id: crypto.randomUUID(),
            agentId: a.agentId,
            workspaceId: a.workspaceId,
            bindingRevision: w.bindingRevision,
            permissions: [...w.permissions],
            state: "active",
            clientId: a.clientId,
            expiresAt: Date.now() + 30 * 86400000,
            revision: 1,
          };
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
            },
          };
        }),
      );
    }
    if (path === "/internal/resource-tool") {
      const b = await parseBody(request);
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
    if (path === "/internal/authorize") {
      const b = await parseBody(request);
      return json(this.db.transaction(() => this.authorize(b)));
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
          return { workspace: w, credentialEpoch: c.credentialEpoch };
        }),
      );
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
          this.db.put("permit/" + operationId, {
            workspaceId: w.id,
            epoch: w.epoch,
            createdAt: Date.now(),
            state: "consumed",
          });
          if (b.mutating === true && w.binding) {
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
          if (b.expectedEpoch !== w.epoch)
            throw new ApiError("STALE_EPOCH", "Epoch changed.", 409);
          w.epoch++;
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
          !["UNKNOWN", "PARTIAL"].includes(String(b.status))
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
        const events = this.db.get<unknown[]>("activity", []);
        events.push(event);
        this.db.put("activity", events.slice(-1000));
        this.bump(this.core());
      });
      return json({ ok: true });
    }
    if (!path.startsWith("/api/v1/admin/"))
      throw new ApiError("NOT_FOUND", "Route not found.", 404);
    const hash = await digest(bearer(request));
    this.auth(hash);
    if (path.startsWith("/api/v1/admin/resources"))
      return resourceAdmin(request, this.db, () => {
        this.auth(hash);
      });
    if (request.method === "GET") return this.readAdmin(path, url);
    const expectedMethod =
      /^\/api\/v1\/admin\/(workspaces|agents)\/[^/]+$/.test(path)
        ? "PATCH"
        : "POST";
    if (request.method !== expectedMethod)
      throw new ApiError("INVALID_INPUT", expectedMethod + " required.", 405);
    const b = await parseBody(request),
      key = id(request.headers.get("Idempotency-Key"), "Idempotency-Key"),
      requestHash = await digest(
        canonical({ path, method: request.method, body: b }),
      );
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
      if (this.db.keys("idempotency/").length >= 1024)
        throw new ApiError(
          "QUOTA_EXCEEDED",
          "Management idempotency budget reached; wait for expiration.",
          429,
        );
      const result = this.writeAdmin(path, b, c);
      this.db.put("idempotency/" + key, {
        hash: requestHash,
        result,
        expires: Date.now() + 86400000,
      });
      this.bump(c);
      for (const k of this.db.keys("idempotency/"))
        if (this.db.get<{ expires: number }>(k).expires < Date.now())
          this.db.delete(k);
      return json(result);
    });
  }
  private authorize(b: Record<string, unknown>): {
    workspace: WorkspaceRecord;
    grant: GrantRecord;
    agent: AgentRecord;
  } {
    const props = b.props as AuthProps;
    if (!props)
      throw new ApiError("AUTH_REQUIRED", "Grant context required.", 401);
    const c = this.core(),
      g = this.db.get<GrantRecord>("grant/" + id(props.grantId));
    if (!g || g.state !== "active" || g.expiresAt <= Date.now())
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
      a.suspended ||
      !w.binding
    )
      throw new ApiError(
        "REVOKED",
        "Assignment, binding or execution policy changed.",
        403,
      );
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
      this.env.PROVIDER_WRITES_ENABLED !== "true"
    )
      throw new ApiError(
        "UNSUPPORTED_INTERFACE",
        "External provider effects remain disabled until live adapter acceptance.",
        409,
      );
    return { workspace: w, grant: g, agent: a };
  }
  private async readAdmin(path: string, url: URL): Promise<Response> {
    // OAuth, Workspace and credential management must not materialize, clone,
    // hash or validate the entire Resource library on every admin GET. The
    // Resource endpoints initialize/validate their library independently.
    const c = this.core(),
      prefix = "/api/v1/admin/";
    if (path === prefix + "diagnostics")
      return json({
        schemaVersion: 1,
        gatewayVersion: VERSION,
        events: this.db.get<Record<string, unknown>[]>("diagnostic-events", []),
      });
    if (path === prefix + "state")
      return json({
        revision: c.revision,
        policyRevision: c.policyRevision,
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
        libraryRevision: this.db.get<{ revision: number }>("library", {
          revision: 0,
        }).revision,
        workspaces: this.db.keys("workspace/").length,
        agents: this.db.keys("agent/").length,
      });
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
      const items = this.db
        .keys(list)
        .map((k) => this.db.get<Record<string, unknown>>(k))
        .filter((v) => list !== "approval/" || Number(v.expiresAt) > Date.now())
        .slice(offset, offset + 100)
        .map((v) => {
          const { handleHash: _, request: __, ...safe } = v;
          return safe;
        });
      return json({
        items,
        revision: c.revision,
        cursor: items.length === 100 ? String(offset + 100) : null,
      });
    }
    if (path === prefix + "activity") {
      const current = this.core(),
        raw = url.searchParams.get("cursor"),
        parts = raw?.split(":"),
        offset = parts ? Number(parts[1]) : 0;
      if (
        (parts &&
          (parts.length !== 2 || Number(parts[0]) !== current.revision)) ||
        !Number.isSafeInteger(offset) ||
        offset < 0
      )
        throw new ApiError(
          "STALE_REVISION",
          "Activity changed; restart the list.",
          409,
        );
      const events = new Map<string, Record<string, unknown>>();
      for (const event of this.db.get<Record<string, unknown>[]>(
        "activity",
        [],
      ))
        events.set(
          String(event.workspaceId) + "/" + String(event.operationId),
          event,
        );
      for (const key of this.db.keys("terminal-notice/")) {
        const row = this.db.get<{
          phase: string;
          event?: Record<string, unknown>;
        }>(key);
        if (["UNKNOWN", "PARTIAL"].includes(row.phase) && row.event)
          events.set(
            String(row.event.workspaceId) + "/" + String(row.event.operationId),
            row.event,
          );
      }
      const status = url.searchParams.get("status"),
        workspaceId = url.searchParams.get("workspaceId");
      const all = [...events.values()]
        .filter(
          (e) =>
            (!status || e.phase === status) &&
            (!workspaceId || e.workspaceId === workspaceId),
        )
        .sort(
          (a, b) =>
            Number(
              ["UNKNOWN", "PARTIAL"].includes(String(b.phase)) && !b.resolution,
            ) -
              Number(
                ["UNKNOWN", "PARTIAL"].includes(String(a.phase)) &&
                  !a.resolution,
              ) ||
            Math.max(
              Number(b.timestamp),
              Number(
                (b.resolution as { timestamp?: number } | undefined)
                  ?.timestamp ?? 0,
              ),
            ) -
              Math.max(
                Number(a.timestamp),
                Number(
                  (a.resolution as { timestamp?: number } | undefined)
                    ?.timestamp ?? 0,
                ),
              ),
        );
      const end = Math.min(all.length, offset + 100);
      return json({
        items: all.slice(offset, end),
        revision: current.revision,
        cursor: end < all.length ? current.revision + ":" + end : null,
      });
    }
    throw new ApiError("NOT_FOUND", "Route not found.", 404);
  }
  private writeAdmin(
    path: string,
    b: Record<string, unknown>,
    c: Core,
  ): unknown {
    const prefix = "/api/v1/admin/";
    if (path === prefix + "workspaces") {
      fields(b, ["label", "permissions"]);
      if (
        this.db.keys("workspace/").length >=
        configuredBudget(this.env.REGISTRY_WORKSPACE_BUDGET, 1000)
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
        permissions:
          b.permissions === undefined
            ? [...DEFAULT_PERMISSIONS]
            : permissions(b.permissions),
        paused: false,
        binding: null,
        epoch: 0,
      };
      this.db.put("workspace/" + w.id, w);
      return w;
    }
    if (path === prefix + "agents") {
      fields(b, ["label", "workspaceId"]);
      const w = this.getWorkspace(id(b.workspaceId));
      if (w.agentId)
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
      const operationId = id(b.operationId),
        observedRevision = str(b.observedRevision, "observedRevision", 256),
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
      const activity = this.db.get<Record<string, unknown>[]>("activity", []);
      for (const event of activity)
        if (event.workspaceId === w.id && event.operationId === operationId)
          event.resolution = resolution;
      this.db.put("activity", activity);
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
        (this.db.keys("permit/").some((key) => {
          const p = this.db.get<{ workspaceId: string; state: string }>(key);
          return p.workspaceId === w.id && p.state === "consumed";
        }) ||
          this.db.keys("terminal-notice/" + w.id + "/").some((key) => {
            const n = this.db.get<{
              phase: string;
              event?: { resolution?: unknown };
            }>(key);
            return (
              ["UNKNOWN", "PARTIAL"].includes(n.phase) && !n.event?.resolution
            );
          }))
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
        if (reservation && reservation.workspaceId !== w.id)
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
          w.permissions = permissions(b.permissions);
          this.revokeWorkspace(w.id);
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
      const target = this.getWorkspace(a.workspaceId);
      if (
        b.decision === "approve" &&
        (target.bindingRevision !== a.bindingRevision ||
          canonical(target.permissions) !== canonical(a.permissionSnapshot) ||
          c.policyRevision !== a.policyRevision ||
          target.paused ||
          c.paused)
      )
        throw new ApiError(
          "APPROVAL_REQUIRED",
          "Binding or policy changed after request creation; restart authorization.",
          409,
        );
      if (!["approve", "deny"].includes(String(b.decision)))
        throw new ApiError(
          "INVALID_INPUT",
          "Decision must be approve or deny.",
        );
      a.state = b.decision === "approve" ? "approved" : "denied";
      a.revision++;
      this.db.put("approval/" + a.id, a);
      const { handleHash: _, request: __, ...safe } = a;
      return safe;
    }
    throw new ApiError("NOT_FOUND", "Route not found.", 404);
  }
}
