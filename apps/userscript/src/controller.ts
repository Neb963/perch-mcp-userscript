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
import { SavedSourceReader } from "./lifecycle.js";
import { GatewayTransport, TransportError } from "./transport.js";
import { ArtifactStore } from "./artifacts.js";
import {
  base64ToBytes,
  canonicalPath,
  digest,
  equalIdentity,
  type KeyValueStore,
  type NativeIdentity,
} from "./native-types.js";

interface Lease {
  workspaceId: string;
  epoch: number;
  bindingRevision: number;
  tabInstanceId: string;
  leaseCredential: string;
  expiresAt: number;
  permissions: string[];
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
  /** Read-only, no network or source effects; scoped to the bound Workspace. */
  capabilityReport?(context: RuntimeContext): Record<string, unknown>;
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
  private renewalInFlight = false;
  private consecutivePollFailures = 0;
  private lastPollSuccessAt?: number;
  private lastFailureCode?: string;
  private currentStatus: ControllerStatus = { connection: "offline" };
  private stopped = true;
  private executing = false;
  /** Browser-local iframe geometry uncertainty; never confused with provider effects. */
  private viewportUncertain = false;
  private running?: Promise<void>;
  private abort?: AbortController;
  constructor(
    readonly adapter: NativeAdapter,
    readonly store: KeyValueStore,
    readonly transport: GatewayTransport,
    readonly tools?: AdditionalTools,
    readonly status: (state: ControllerStatus) => void = () => {},
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
      consecutivePollFailures: this.consecutivePollFailures,
      lastPollSuccessAt: this.lastPollSuccessAt ?? null,
      leasePresent: !!this.lease,
      leaseRemainingMs: this.lease ? Math.max(0, this.lease.expiresAt - Date.now()) : 0,
      stopped: this.stopped,
    };
  }
  async attach(workspace: Record<string, unknown>): Promise<void> {
    if (this.executing)
      throw Object.assign(
        new Error(
          "An operation is still executing. Pause and reconcile before switching Workspaces.",
        ),
        { code: "TAB_BUSY" },
      );
    await this.pause();
    if (typeof workspace.id !== "string") throw new Error("Invalid Workspace.");
    const probe = await this.adapter.probe();
    if (!probe.ready || !probe.identity)
      throw new Error(
        "Native editor is not ready; inspect the read-only probe.",
      );
    const identity = probe.identity;
    const candidateVfs = new VirtualFileSystem(
      this.adapter,
      this.store,
      String(workspace.id),
    );
    await this.syncResolvedLocal(candidateVfs, String(workspace.id));
    const binding = {
      ...identity,
      browserInstallationId: await this.transport.installationId(),
    };
    // Bind is an explicit manager action. Claim does not create or change authorization.
    const claim = (await this.transport.tab("/api/v1/tab/claim", {
      workspaceId: workspace.id,
      binding,
      tabInstanceId: this.tabInstanceId,
      adapterVersion: "1",
    })) as Lease;
    if (
      !claim ||
      claim.workspaceId !== workspace.id ||
      claim.tabInstanceId !== this.tabInstanceId ||
      !Number.isInteger(claim.epoch) ||
      claim.epoch < 1 ||
      !claim.leaseCredential ||
      !Array.isArray(claim.permissions)
    )
      throw new Error("Gateway returned an invalid lease.");
    this.adapter.bind(identity);
    this.identity = identity;
    this.lease = claim;
    this.vfs = candidateVfs;
    this.source = new SourceTools(this.vfs, this.adapter);
    this.viewportUncertain = false; // New document/lease: old CSS is not canonical provider state.
    this.stopped = false;
    this.lastFailureCode = undefined;
    this.consecutivePollFailures = 0;
    this.pollAbort = new AbortController();
    this.heartbeat = setInterval(() => {
      void this.renew(claim);
    }, 60000);
    (this.heartbeat as unknown as { unref?: () => void }).unref?.();
    this.updateStatus({
      connection: "connected",
      workspace: String(workspace.id),
      dirty: probe.dirty,
    });
    this.running = this.poll().catch((error: unknown) => {
      if (this.lease !== claim || this.stopped) return;
      this.stopped = true;
      this.pollAbort?.abort();
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = undefined;
      this.lastFailureCode = error instanceof TransportError
        ? error.code : "POLL_FAILED";
      this.updateStatus({
        connection: "offline",
        workspace: String(workspace.id),
        reason: `Poll stopped (${this.lastFailureCode}). Inspect diagnostics and reconcile uncertain operations before reconnecting.`,
      });
    });
  }
  async pause(): Promise<void> {
    this.stopped = true;
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
    this.tools?.dispose?.();
    this.updateStatus({
      connection: this.transport.configuration().paired ? "paused" : "unpaired",
    });
  }
  private async renew(lease: Lease): Promise<void> {
    if (this.stopped || this.lease !== lease || this.renewalInFlight) return;
    this.renewalInFlight = true;
    try {
      const state = (await this.transport.tab(
        "/api/v1/tab/heartbeat",
        this.ids(lease),
        lease.leaseCredential,
      )) as { expiresAt: number; permissions: string[] };
      if (this.stopped || this.lease !== lease) return;
      if (
        !Number.isSafeInteger(state.expiresAt) ||
        state.expiresAt <= Date.now()
      )
        throw new Error("Expired lease.");
      lease.expiresAt = state.expiresAt;
      if (Array.isArray(state.permissions))
        lease.permissions = lease.permissions.filter((p) =>
          state.permissions.includes(p),
        );
    } catch (error) {
      if (this.stopped || this.lease !== lease) return;
      const code = error instanceof TransportError ? error.code : "HEARTBEAT_FAILED";
      this.lastFailureCode = code;
      // The poll request also refreshes the same lease. A transient failed
      // heartbeat is not proof of lease revocation or loss of connection.
      const temporary = ["GATEWAY_TIMEOUT", "GATEWAY_UNAVAILABLE"].includes(code);
      if (temporary && lease.expiresAt > Date.now() + 1000) {
        this.updateStatus({
          connection: "degraded", workspace: lease.workspaceId,
          reason: `Heartbeat temporarily unavailable (${code}); existing lease retained.`,
        });
        return;
      }
      this.stopped = true;
      this.pollAbort?.abort();
      this.abort?.abort();
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = undefined;
      this.updateStatus({
        connection: "blocked", workspace: lease.workspaceId,
        reason: `Lease renewal rejected (${code}). Inspect pending effects before reconnecting.`,
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
    if (this.vfs) return this.vfs;
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
    if (
      !workspace ||
      !(
        workspace.binding ||
        (workspace.recoveryBinding as { binding?: unknown } | undefined)
          ?.binding
      ) ||
      !equalIdentity(
        (workspace.binding ||
          (workspace.recoveryBinding as { binding?: unknown })
            .binding) as unknown as NativeIdentity,
        await this.adapter.identity(),
      )
    )
      throw new Error(
        "Open the operation’s exact Generator and Draft before resolving.",
      );
    const vfs = new VirtualFileSystem(this.adapter, this.store, workspaceId),
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
    for (const journal of await vfs.unresolved())
      await vfs.acknowledgeReconciliation(journal.id, snapshot.revision);
    const key = `perch:operation:${workspaceId}:${operationId}`,
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
  async localArtifacts() {
    return this.artifacts.list();
  }
  private async poll(): Promise<void> {
    while (!this.stopped && this.lease) {
      const lease = this.lease;
      let reply: { operations?: unknown[]; expiresAt?: number };
      try {
        // The Worker holds an idle poll for up to 25 seconds. A 45-second
        // browser budget allows network/proxy latency without a false offline
        // transition. Abort on explicit Pause or document navigation.
        reply = (await this.transport.tab(
          "/api/v1/tab/poll", this.ids(lease), lease.leaseCredential,
          { timeoutMs: 45000, signal: this.pollAbort?.signal },
        )) as { operations?: unknown[]; expiresAt?: number };
      } catch (error) {
        if (this.stopped || this.lease !== lease) return;
        const code = error instanceof TransportError ? error.code : "POLL_FAILED";
        this.lastFailureCode = code;
        this.consecutivePollFailures++;
        // The gateway serializes dispatched Operations. Re-polling the
        // current lease never issues a new Workspace claim or duplicates an
        // operation ACK. Only transient network failures are retried here.
        if (
          !["GATEWAY_TIMEOUT", "GATEWAY_UNAVAILABLE"].includes(code) ||
          this.consecutivePollFailures >= 3 ||
          Date.now() + 3000 >= lease.expiresAt
        ) throw error;
        this.updateStatus({
          connection: "degraded", workspace: lease.workspaceId,
          reason: `Poll interrupted (${code}); recovering existing lease, attempt ${this.consecutivePollFailures + 1}/3.`,
        });
        await new Promise((resolve) => setTimeout(resolve, 750 * this.consecutivePollFailures));
        continue;
      }
      this.consecutivePollFailures = 0;
      this.lastPollSuccessAt = Date.now();
      this.lastFailureCode = undefined;
      if (this.currentStatus.connection === "degraded" && !this.viewportUncertain)
        this.updateStatus({ connection: "connected", workspace: lease.workspaceId });
      if (this.stopped || this.lease !== lease) return;
      if (
        !reply ||
        !Array.isArray(reply.operations) ||
        reply.operations.length > 8
      )
        throw new Error("Invalid poll response.");
      if (typeof reply.expiresAt === "number")
        lease.expiresAt = reply.expiresAt;
      for (const raw of reply.operations) {
        if (this.stopped) break;
        await this.execute(raw, lease);
      }
      // Poll implementations may return immediately when idle; bounded jitter prevents a hot loop.
      if (!reply.operations.length)
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
  private async executeOperation(raw: unknown, lease: Lease): Promise<void> {
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
    const key = `perch:operation:${lease.workspaceId}:${envelope.operationId}`;
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
      const message = envelope.tool === 'fetch_generator' &&
        typeof (error as {message?:unknown}).message === 'string' &&
        /^(?:Public (?:metadata|asset|generator|source|manifest)|Use a canonical public)/.test((error as Error).message)
          ? `fetch_generator/public-api: ${(error as Error).message.slice(0,260)}`
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
    const held = await vfs.unresolved();
    if (!held.length) return;
    const snapshot = await vfs.snapshot();
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
          row.workspaceId === workspaceId &&
          row.resolution &&
          typeof row.resolution === "object" &&
          (row.resolution as Record<string, unknown>).resolvedByOperator ===
            true &&
          (row.resolution as Record<string, unknown>).observedRevision ===
            snapshot.revision,
      );
      if (resolved) {
        const decision = resolved.resolution as {
          timestamp?: number;
          observedDigest?: string;
        };
        if (decision.observedDigest !== snapshot.revision.split(":")[1])
          throw new Error("Resolution digest differs from current source.");
        for (const journal of held.filter(
          (j) => j.createdAt <= (decision.timestamp ?? 0),
        ))
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
    const prefix = `perch:operation:${workspaceId}:`;
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
      const base = await this.source.call(name, args) as Record<string, unknown>;
      const caps = base.capabilities as {
        nativeSave?:boolean;sourceRead?:boolean;sourceWrite?:boolean;
        sourceWriteBlocked?:string[];
      } | undefined;
      const authorized = [...new Set(lease.permissions)].sort();
      const gatewayObservation=this.transport.gatewayPolicySnapshot();
      const gatewayPolicy=gatewayObservation.providerWritesEnabled;
      // Cached policy is diagnostic, not authorization. The authoritative
      // Registry rechecks the current policy for every tool admission.
      const nativeDetected = caps?.nativeSave === true;
      const adapterAccepted = this.adapter.options.externalWritesVerified === true;
      const hasSaveGrant = authorized.includes('SAVE');
      const leaseHeld = this.lease === lease && !this.stopped && Date.now() < lease.expiresAt;
      const reasons = [
        ...(!nativeDetected ? ['NATIVE_SAVE_INTERFACE_UNAVAILABLE'] : []),
        ...(!adapterAccepted ? ['NATIVE_SAVE_ACCEPTANCE_NOT_VERIFIED'] : []),
        ...(gatewayPolicy !== true ? [gatewayPolicy === false ? 'GATEWAY_PROVIDER_WRITES_DISABLED' : 'GATEWAY_POLICY_UNKNOWN'] : []),
        ...(!hasSaveGrant ? ['SAVE_PERMISSION_NOT_GRANTED'] : []),
        ...(!leaseHeld ? ['WRITER_LEASE_NOT_HELD'] : []),
        ...((caps?.sourceWriteBlocked ?? []).length ? ['NATIVE_EDITOR_MUTATION_BLOCKED'] : []),
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
            available:leaseHeld && caps?.sourceRead === true && authorized.includes('READ_SOURCE') },
          sourceWrite: { detected:caps?.sourceWrite === true,
            authorized:authorized.includes('WRITE_SOURCE'),
            available:leaseHeld && caps?.sourceWrite === true && authorized.includes('WRITE_SOURCE'),
            reasons:caps?.sourceWriteBlocked ?? [] },
          saveGenerator: {
            detected:nativeDetected,adapterAccepted,gatewayPolicy,
            gatewayPolicyObservedAt:gatewayObservation.observedAt,
            gatewayPolicyIsLastObservation:true,
            authorized:hasSaveGrant,available:reasons.length===0,reasons,
          },
          preview: this.tools?.capabilityReport?.(context) ?? {
            inspection:'NOT_INSTRUMENTED',
          },
          policyBoundary: {
            privilegedSaveAndLifecycle:'gated',
            generatorRuntime:'Preview JavaScript can make normal generator requests; this is not equivalent to authorized privileged editor Save.',
          },
        },
      };
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
    if (this.source?.supports(name)) return this.source.call(name, args);
    if (this.tools?.supports(name)) return this.tools.call(name, args, context);
    throw Object.assign(
      new Error("No verified authorized adapter for this capability."),
      { code: "UNSUPPORTED_INTERFACE" },
    );
  }
}
