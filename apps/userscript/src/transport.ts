import type { KeyValueStore } from "./native-types.js";

export interface TransportDiagnostic {
  at: number;
  route: string;
  method: string;
  elapsedMs: number;
  code: string;
  status: number;
  traceId?: string;
}
export class TransportError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 0,
    readonly traceId?: string,
    readonly connectivityRetryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "TransportError";
  }
}
export interface Pairing {
  schemaVersion: 1;
  origin: string;
  browserInstallationId: string;
  adminCredential: string;
  executionCredential: string;
}
export function gatewayOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TransportError(
      "INVALID_INPUT",
      "Enter the HTTPS gateway origin.",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    url.port ||
    !url.hostname.includes(".") ||
    /^(localhost|.*\.localhost)$/.test(url.hostname) ||
    /^[\d.]+$/.test(url.hostname) ||
    url.hostname.includes(":")
  ) {
    throw new TransportError(
      "INVALID_INPUT",
      "Use an HTTPS gateway origin without credentials, path, port or query.",
    );
  }
  return url.origin;
}
/** Isolated-context fetch; redirect:error prevents credential forwarding BEFORE any redirect. */
export class GatewayTransport {
  private retryConnectivityAt = 0;
  connectivityRetryDelayMs(): number { return Math.max(0,this.retryConnectivityAt-Date.now()); }
  private readonly recent: TransportDiagnostic[] = [];
  private readonly preservedFailures: TransportDiagnostic[] = [];
  private persistence: Promise<void> = Promise.resolve();
  private readonly failureKey = 'perch:transport-failures-v1';
  diagnostics(): { schemaVersion: 1; events: TransportDiagnostic[]; preservedFailures: TransportDiagnostic[] } {
    return { schemaVersion: 1, events: this.recent.map((e) => ({ ...e })),
      preservedFailures: this.preservedFailures.map((e) => ({ ...e })) };
  }
  /** Log only bounded, non-sensitive metadata. Failed operations persist across tab reloads. */
  private recordDiagnostic(event: TransportDiagnostic): void {
    this.recent.push(event);
    if (this.recent.length > 100) this.recent.splice(0, this.recent.length - 100);
    if (event.code === 'OK') return;
    this.preservedFailures.push(event);
    const cutoff = Date.now() - 7 * 86400000;
    const valid = this.preservedFailures.filter(e => e.at >= cutoff).slice(-256);
    this.preservedFailures.splice(0, this.preservedFailures.length, ...valid);
    const snapshot = valid.map(e => ({ ...e }));
    this.persistence = this.persistence.catch(() => undefined)
      .then(() => this.store.set(this.failureKey, snapshot))
      .catch(() => undefined);
  }
  recordBootstrapFailure(stage: string, code: string): void {
    if (!/^[A-Z][A-Z0-9_]{1,47}$/.test(stage) ||
        !/^[A-Z][A-Z0-9_]{1,47}$/.test(code)) return;
    this.recordDiagnostic({ at: Date.now(), route: '/local/bootstrap', method: 'STATE',
      elapsedMs: 0, status: 0, code: stage + ':' + code });
  }
  private pairing?: Pairing;
  private suggestedOrigin = "";
  private lastGatewayPolicy?: { providerWritesEnabled: boolean; nativeActionsEnabled: boolean | null; observedAt: number };
  /** A last-observed policy is diagnostic only; Registry remains authoritative on every admission. */
  gatewayPolicySnapshot(): {providerWritesEnabled: boolean|null; nativeActionsEnabled: boolean|null; observedAt: number|null} {
    return {providerWritesEnabled:this.lastGatewayPolicy?.providerWritesEnabled??null,
      nativeActionsEnabled:this.lastGatewayPolicy?.nativeActionsEnabled??null,
      observedAt:this.lastGatewayPolicy?.observedAt??null};
  }
  constructor(
    private readonly store: KeyValueStore,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  async initialize(): Promise<void> {
    const suggestion = await this.store.get<string>("perch:suggested-origin");
    if (suggestion) this.suggestedOrigin = gatewayOrigin(suggestion);
    // Never allow corrupt diagnostics to prevent pairing or connection.
    try {
      const history = await this.store.get<unknown>(this.failureKey);
      if (Array.isArray(history)) for (const candidate of history.slice(-256)) {
        if (!candidate || typeof candidate !== 'object') continue;
        const row = candidate as Record<string, unknown>;
        if (typeof row.at !== 'number' || !Number.isSafeInteger(row.at) ||
            row.at < Date.now() - 7 * 86400000 || row.at > Date.now() + 60_000 ||
            typeof row.code !== 'string' || !/^[A-Z0-9_:]{1,100}$/.test(row.code) ||
            typeof row.route !== 'string' || !/^\/(?:api\/v1\/(?:admin|tab)\/|health|local\/)[a-zA-Z0-9_/:.-]{0,110}$/.test(row.route) ||
            typeof row.method !== 'string' || !/^(?:GET|POST|PUT|PATCH|DELETE|STATE)$/.test(row.method) ||
            typeof row.status !== 'number' || row.status < 0 || row.status > 599 ||
            typeof row.elapsedMs !== 'number' || row.elapsedMs < 0) continue;
        this.preservedFailures.push({ at: row.at, method: row.method, route: row.route,
          code: row.code, status: row.status, elapsedMs: row.elapsedMs,
          ...(typeof row.traceId === 'string' && /^[0-9a-f-]{36}$/.test(row.traceId)
            ? { traceId: row.traceId } : {}) });
      }
    } catch { /* Diagnostic history is auxiliary and must not block connection. */ }
    const stored = await this.store.get<Pairing>("perch:pairing");
    if (stored) {
      if (
        stored.schemaVersion !== 1 ||
        gatewayOrigin(stored.origin) !== stored.origin ||
        !stored.adminCredential ||
        !stored.executionCredential
      )
        throw new TransportError(
          "INCOMPATIBLE_VERSION",
          "Stored pairing is incompatible. Re-pair after recovery.",
        );
      this.pairing = stored;
    }
  }
  configuration(): { origin: string; paired: boolean } {
    return {
      origin: this.pairing?.origin ?? this.suggestedOrigin,
      paired: !!this.pairing,
    };
  }
  async installationId(): Promise<string> {
    let id = await this.store.get<string>("perch:installation-id");
    if (!id) {
      id = crypto.randomUUID();
      await this.store.set("perch:installation-id", id);
    }
    return id;
  }
  async health(origin = this.pairing?.origin): Promise<unknown> {
    if (!origin)
      throw new TransportError("AUTH_REQUIRED", "Pair a gateway first.");
    const target=gatewayOrigin(origin);
    const response=await this.send(target, "GET", "/health");
    if(target===this.pairing?.origin)this.retryConnectivityAt=0;
    if(target===this.pairing?.origin && response && typeof response==='object') {
      const value=(response as Record<string,unknown>).providerWritesEnabled;
      const nativeActions=(response as Record<string,unknown>).nativeActionsEnabled;
      if(typeof value==='boolean')
        this.lastGatewayPolicy={providerWritesEnabled:value,
          nativeActionsEnabled:typeof nativeActions==='boolean'?nativeActions:null,
          observedAt:Date.now()};
      else this.lastGatewayPolicy=undefined;
    }
    return response;
  }
  async pair(origin: string, bootstrapSecret: string): Promise<void> {
    const approvedOrigin = gatewayOrigin(origin);
    if (bootstrapSecret.length < 43 || bootstrapSecret.length > 256)
      throw new TransportError(
        "INVALID_INPUT",
        "Bootstrap secret must contain43–256characters (at least32random bytes before encoding).",
      );
    if (this.pairing && approvedOrigin !== this.pairing.origin)
      throw new TransportError(
        "RESOURCE_CONFLICT",
        "Disconnect the existing gateway before pairing another.",
      );
    const browserInstallationId = await this.installationId();
    const result = (await this.send(
      approvedOrigin,
      "POST",
      "/api/v1/admin/pair",
      { bootstrapSecret, browserInstallationId, issuer: approvedOrigin },
    )) as Record<string, unknown>;
    if (
      typeof result.adminCredential !== "string" ||
      typeof result.executionCredential !== "string"
    )
      throw new TransportError(
        "INVALID_RESPONSE",
        "Gateway returned an invalid pairing response; use recovery instead of repeating uncertain pairing.",
      );
    const next: Pairing = {
      schemaVersion: 1,
      origin: approvedOrigin,
      browserInstallationId,
      adminCredential: result.adminCredential,
      executionCredential: result.executionCredential,
    };
    await this.store.set("perch:pairing", next);
    this.pairing = next;
    this.lastGatewayPolicy=undefined;
  }
  async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    if (
      !path.startsWith("/api/v1/admin/") &&
      !path.startsWith("/api/v1/approval/")
    )
      throw new TransportError(
        "PATH_DENIED",
        "Management route not permitted.",
      );
    return this.authenticated("admin", method, path, body);
  }
  async tab(
    path: string,
    body: unknown,
    leaseSecret?: string,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<unknown> {
    if (
      !/^\/api\/v1\/tab\/(claim|poll|reply|release|heartbeat|ticket|permit|music|music-result|image)$/.test(
        path,
      )
    )
      throw new TransportError("PATH_DENIED", "Tab route not permitted.");
    return this.authenticated(
      "execution",
      "POST",
      path,
      body,
      leaseSecret,
      options,
    );
  }
  private async authenticated(
    role: "admin" | "execution",
    method: string,
    path: string,
    body?: unknown,
    leaseSecret?: string,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<unknown> {
    const paired = this.pairing;
    if (!paired)
      throw new TransportError(
        "AUTH_REQUIRED",
        "Pair this browser with the gateway.",
      );
    return this.send(
      paired.origin,
      method,
      path,
      body,
      leaseSecret ??
        (role === "admin"
          ? paired.adminCredential
          : paired.executionCredential),
      false,
      options,
    );
  }
  async exportResources(): Promise<Uint8Array> {
    if (!this.pairing)
      throw new TransportError("AUTH_REQUIRED", "Pair this browser first.");
    return (await this.send(
      this.pairing.origin,
      "GET",
      "/api/v1/admin/resources/export",
      undefined,
      this.pairing.adminCredential,
      true,
    )) as Uint8Array;
  }
  async recover(origin: string, recoverySecret: string): Promise<void> {
    const approved = gatewayOrigin(origin);
    if (recoverySecret.length < 43 || recoverySecret.length > 256)
      throw new TransportError(
        "INVALID_INPUT",
        "Use a fresh43–256character recovery secret.",
      );
    const browserInstallationId = await this.installationId();
    const value = (await this.send(approved, "POST", "/api/v1/admin/recover", {
      recoverySecret,
      browserInstallationId,
    })) as Record<string, unknown>;
    if (
      typeof value.adminCredential !== "string" ||
      typeof value.executionCredential !== "string"
    )
      throw new TransportError(
        "INVALID_RESPONSE",
        "Recovery response invalid. Rotate recovery secret before retrying uncertain recovery.",
      );
    const next: Pairing = {
      schemaVersion: 1,
      origin: approved,
      browserInstallationId,
      adminCredential: value.adminCredential,
      executionCredential: value.executionCredential,
    };
    await this.store.set("perch:pairing", next);
    this.pairing = next;
  }
  async importSettingsOrigin(origin: string): Promise<void> {
    this.suggestedOrigin = gatewayOrigin(origin);
    await this.store.set("perch:suggested-origin", this.suggestedOrigin);
  }
  async disconnect(): Promise<void> {
    await this.store.delete("perch:pairing");
    this.pairing = undefined;
  }
  private async send(
    origin: string,
    method: string,
    path: string,
    body?: unknown,
    credential?: string,
    binary = false,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<unknown> {
    const started = Date.now();
    // Only the bounded route template is recorded. Never record Origin
    // headers, query strings, payloads, authentication headers or credentials.
    const route = path.split("?")[0]!
      .replace(/\/(workspaces|agents|approvals|grants|resources)\/[^/]+/g, "/$1/:id")
      .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ":id")
      .slice(0, 120);
    try {
      const result = await this.sendInternal(origin, method, path, body, credential, binary, options);
      this.recordDiagnostic({
        at: started, method, route, elapsedMs: Date.now() - started,
        status: 200, code: "OK",
      });
      return result;
    } catch (error) {
      const failure = error instanceof TransportError ? error : undefined;
      this.recordDiagnostic({
        at: started, method, route, elapsedMs: Date.now() - started,
        status: failure?.status ?? 0,
        code: failure?.code ?? "LOCAL_ERROR",
        ...(failure?.traceId ? { traceId: failure.traceId } : {}),
      });
      throw error;
    }
  }
  private async sendInternal(
    origin: string,
    method: string,
    path: string,
    body?: unknown,
    credential?: string,
    binary = false,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<unknown> {
    if (
      !path.startsWith("/") ||
      path.includes("..") ||
      path.includes("#") ||
      path.includes("\\")
    )
      throw new TransportError("PATH_DENIED", "Invalid gateway route.");
    const url = new URL(path, origin);
    for (const [name, value] of url.searchParams) {
      if (name === "cursor" && /^[A-Za-z0-9._:-]{1,512}$/.test(value)) continue;
      if (name === "limit" && /^(?:[1-9][0-9]?|100)$/.test(value)) continue;
      throw new TransportError(
        "PATH_DENIED",
        "Only bounded pagination query values are permitted.",
      );
    }
    if (url.origin !== origin)
      throw new TransportError("PATH_DENIED", "Gateway origin mismatch.");
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    if (
      encoded &&
      new TextEncoder().encode(encoded).length >
        (path.startsWith("/api/v1/admin/resources/import")
          ? 24 * 1024 * 1024
          : 512 * 1024)
    )
      throw new TransportError(
        "LIMIT_EXCEEDED",
        "Gateway request exceeds 512 KiB.",
      );
    const headers = new Headers({
      Accept: binary ? "application/zip" : "application/json",
    });
    if (body !== undefined) headers.set("Content-Type", "application/json");
    if (credential) headers.set("Authorization", `Bearer ${credential}`);
    if (!["GET", "HEAD"].includes(method))
      headers.set("Idempotency-Key", crypto.randomUUID());
    let response!: Response;
    // Only idempotent GETs may be retried. Never automatically replay a
    // management write, tab operation or an uncertain OAuth-related effect.
    const attempts = method === "GET" && !binary ? 2 : 1;
    const defaultTimeoutMs = method === "GET" && !binary ? 15000 : 30000;
    const timeoutMs = options?.timeoutMs ?? defaultTimeoutMs;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        response = await this.fetcher(url, {
          method,
          headers,
          body: encoded,
          credentials: "omit",
          redirect: "error",
          cache: "no-store",
          referrerPolicy: "no-referrer",
          signal: options?.signal
            ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
            : AbortSignal.timeout(timeoutMs),
        });
        break;
      } catch (error) {
        if (options?.signal?.aborted)
          throw new TransportError(
            "CANCELLED",
            "The request was cancelled. Do not replay any uncertain write.",
          );
        if (attempt + 1 < attempts) {
          await new Promise<void>((resolve) => setTimeout(resolve, 300));
          continue;
        }
        const timedOut = error instanceof Error &&
          (error.name === "TimeoutError" || error.name === "AbortError");
        throw new TransportError(
          timedOut ? "GATEWAY_TIMEOUT" : "GATEWAY_UNAVAILABLE",
          timedOut
            ? "Gateway read timed out. Only safe read-only requests were retried. Refresh and check Cloudflare health."
            : "Gateway connection was rejected or interrupted. Check browser Console for a blocked CORS/CSP request, then verify Cloudflare health. Writes are never automatically retried.",
        );
      }
    }
    if (response.url && new URL(response.url).origin !== origin)
      throw new TransportError(
        "PATH_DENIED",
        "Gateway response origin mismatch.",
      );
    if (
      !binary &&
      !response.headers.get("content-type")?.includes("application/json")
    )
      throw new TransportError(
        "INVALID_RESPONSE",
        "Gateway response must be JSON.",
      );
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    if (reader) {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          length += value.length;
          if (length > (binary ? 16 * 1024 * 1024 : 512 * 1024))
            throw new TransportError(
              "LIMIT_EXCEEDED",
              "Gateway response exceeds 512 KiB.",
            );
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
    }
    const bytes = new Uint8Array(length);
    let cursor = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, cursor);
      cursor += chunk.length;
    }
    if (binary && response.ok) return bytes;
    let data: unknown;
    try {
      data = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } catch {
      throw new TransportError(
        "INVALID_RESPONSE",
        "Gateway returned invalid JSON.",
      );
    }
    if (!response.ok) {
      const code =
        typeof data === "object" &&
        data !== null &&
        "code" in data &&
        typeof data.code === "string"
          ? data.code
          : `HTTP_${response.status}`;
      // Server/provider text can contain source or secrets: expose stable code, not arbitrary raw messages.
      const traceId = typeof data === "object" && data !== null &&
        "traceId" in data && typeof data.traceId === "string" &&
        /^[0-9a-f-]{36}$/.test(data.traceId) ? data.traceId : undefined;
      const retry = response.status===503 && code==="GATEWAY_DEGRADED" &&
        typeof data==="object" && data!==null && "connectivityRetryAfterSeconds" in data &&
        data.connectivityRetryAfterSeconds===300 ? 300 : undefined;
      if(retry && origin===this.pairing?.origin)
        this.retryConnectivityAt=Math.max(this.retryConnectivityAt,Date.now()+retry*1000);
      throw new TransportError(
        code,
        retry ? "Daily gateway SQL allowance exhausted. Automatic connectivity retries are paused for up to five minutes."
          : `Gateway rejected the request (${code}). Refresh authoritative state before retrying.`,
        response.status,
        traceId,
        retry,
      );
    }
    return data;
  }
}
