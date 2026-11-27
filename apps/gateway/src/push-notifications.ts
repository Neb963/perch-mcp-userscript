import type { DurableObjectState, WebSocket as DurableSocket } from "@cloudflare/workers-types";
import { ApiError, digest, randomSecret } from "./common.js";
import { SqlRecords } from "./sql.js";

export const NOTIFICATION_PROTOCOL = "perch-notify-v1";
const SESSION_KEY = "push-state/v1";
const TICKET_MS = 30_000;
export interface PushLease {
  workspaceId: string;
  epoch: number;
  bindingRevision: number;
  tabInstanceId: string;
  secretHash: string;
  expiresAt: number;
}
interface Scope {
  version: 1;
  workspaceId: string;
  epoch: number;
  bindingRevision: number;
  tabInstanceId: string;
  generation: string;
}
interface Session extends Scope {
  phase: "TICKET" | "CONNECTED";
  expiresAt: number;
  ticketDigest?: string;
}
declare const WebSocketPair: { new(): { 0: DurableSocket; 1: DurableSocket } };

/** The nonce travels in an offered subprotocol, never in the URL. */
export function validatePushUpgrade(request: Request): string {
  if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket")
    throw new ApiError("INVALID_INPUT", "A WebSocket upgrade is required.", 426);
  const protocols = (request.headers.get("sec-websocket-protocol") ?? "").split(",").map(value => value.trim());
  if (protocols.length !== 2 || protocols[0] !== NOTIFICATION_PROTOCOL || !/^ticket\.[A-Za-z0-9_-]{43}$/.test(protocols[1]!))
    throw new ApiError("AUTH_REQUIRED", "A notification ticket is required.", 401);
  return protocols[1]!.slice(7);
}
function sameScope(a: Pick<Scope, "workspaceId" | "epoch" | "bindingRevision" | "tabInstanceId">,
  b: Pick<Scope, "workspaceId" | "epoch" | "bindingRevision" | "tabInstanceId">): boolean {
  return a.workspaceId === b.workspaceId && a.epoch === b.epoch &&
    a.bindingRevision === b.bindingRevision && a.tabInstanceId === b.tabInstanceId;
}
function scope(value: unknown, session = false): Scope | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const s = value as Record<string, unknown>;
  if (s.version !== 1 || typeof s.workspaceId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(s.workspaceId) ||
      typeof s.tabInstanceId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(s.tabInstanceId) ||
      !Number.isSafeInteger(s.epoch) || Number(s.epoch) < 1 ||
      !Number.isSafeInteger(s.bindingRevision) || Number(s.bindingRevision) < 1 ||
      typeof s.generation !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s.generation)) return;
  const fields = ["version", "workspaceId", "epoch", "bindingRevision", "tabInstanceId", "generation",
    ...(session ? ["phase", "expiresAt", "ticketDigest"] : [])];
  if (Object.keys(s).some(name => !fields.includes(name))) return;
  return s as unknown as Scope;
}

/** Advisory server-only sockets. All execution remains authenticated HTTP. */
export class PushNotifications {
  constructor(private readonly db: SqlRecords, private readonly state: DurableObjectState,
    private readonly options: { enabled: boolean; getLease(): PushLease | undefined; allowedOrigins: readonly string[] }) {
    if (!this.enabled) this.close();
  }
  get enabled(): boolean {
    return this.options.enabled && typeof this.state.acceptWebSocket === "function" &&
      typeof this.state.getWebSockets === "function";
  }
  private session(): Session | undefined {
    const value = this.db.get<Session | undefined>(SESSION_KEY);
    if (value === undefined) return;
    if (!scope(value, true) || !["TICKET", "CONNECTED"].includes(value.phase) ||
        !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= 0 ||
        (value.phase === "TICKET" && (typeof value.ticketDigest !== "string" || !/^[0-9a-f]{64}$/.test(value.ticketDigest))) ||
        (value.phase === "CONNECTED" && value.ticketDigest !== undefined))
      throw new Error("PUSH_STATE_CORRUPT");
    return value;
  }
  private requireEnabled(): void {
    if (!this.enabled) throw new ApiError("NOT_FOUND", "Notifications are disabled or unsupported.", 404);
  }
  async issue(lease: PushLease): Promise<{ version: 1; protocol: string; ticket: string; expiresAt: number }> {
    this.requireEnabled();
    const ticket = randomSecret(), ticketDigest = await digest(ticket);
    const expiresAt = Math.min(Date.now() + TICKET_MS, lease.expiresAt);
    this.db.transaction(() => {
      const current = this.options.getLease();
      if (!current || !sameScope(current, lease) || current.secretHash !== lease.secretHash || current.expiresAt <= Date.now())
        throw new ApiError("STALE_EPOCH", "Lease changed before issuing a notification ticket.", 409);
      // Validate existing auxiliary state instead of guessing a corrupt schema.
      this.session();
      this.db.put(SESSION_KEY, { version: 1, phase: "TICKET", workspaceId: current.workspaceId,
        epoch: current.epoch, bindingRevision: current.bindingRevision, tabInstanceId: current.tabInstanceId,
        generation: crypto.randomUUID(), expiresAt, ticketDigest } satisfies Session);
    });
    return { version: 1, protocol: NOTIFICATION_PROTOCOL, ticket, expiresAt };
  }
  async upgrade(request: Request): Promise<Response> {
    this.requireEnabled();
    const ticket = validatePushUpgrade(request);
    if (!this.options.allowedOrigins.includes(request.headers.get("origin") ?? ""))
      throw new ApiError("SCOPE_DENIED", "Notification origin is not allowed.", 403);
    const ticketDigest = await digest(ticket);
    const attached = this.db.transaction(() => {
      const pending = this.session(), lease = this.options.getLease();
      if (!pending || pending.phase !== "TICKET" || pending.ticketDigest !== ticketDigest ||
          pending.expiresAt <= Date.now() || !lease || lease.expiresAt <= Date.now() || !sameScope(pending, lease))
        throw new ApiError("AUTH_REQUIRED", "Notification ticket is invalid or expired.", 401);
      // Closing peers can remain allocated until their close handshake ends.
      // Permit one replacement, but never grow a closing-socket backlog.
      if (this.state.getWebSockets(NOTIFICATION_PROTOCOL).length >= 2)
        throw new ApiError("QUOTA_EXCEEDED", "Notification connections are settling; use HTTP fallback.", 429);
      const { ticketDigest: _, ...connected } = pending;
      this.db.put(SESSION_KEY, { ...connected, phase: "CONNECTED" } satisfies Session);
      const { phase: __, expiresAt: ___, ...attachment } = connected;
      return attachment;
    });
    this.close();
    const pair = new WebSocketPair(), client = pair[0], server = pair[1];
    this.state.acceptWebSocket(server, [NOTIFICATION_PROTOCOL]);
    server.serializeAttachment(attached);
    server.send(JSON.stringify({ version: 1, type: "ready" }));
    const init: ResponseInit & { webSocket: DurableSocket } = {
      status: 101, webSocket: client, headers: { "Sec-WebSocket-Protocol": NOTIFICATION_PROTOCOL },
    };
    return new Response(null, init);
  }
  /** The optional lease must be read in the immediately preceding admission
   * transaction, with no await between that commit and this call. Other callers
   * re-read canonical authority here. Caller catches auxiliary storage faults. */
  notify(committedLease?: PushLease): void {
    if (!this.enabled) { this.close(); return; }
    const sockets = this.state.getWebSockets(NOTIFICATION_PROTOCOL);
    if (!sockets.length) return;
    const lease = committedLease ?? this.options.getLease(), session = this.session();
    for (const socket of sockets) {
      const attachment = scope(socket.deserializeAttachment());
      if (!lease || lease.expiresAt <= Date.now() || session?.phase !== "CONNECTED" ||
          !attachment || !sameScope(attachment, lease) || attachment.generation !== session.generation) {
        try { socket.close(1008, "Notification session expired."); } catch { /* Already disconnected. */ }
        continue;
      }
      if (socket.readyState !== 1) continue;
      try { socket.send(JSON.stringify({ version: 1, type: "available" })); }
      catch { try { socket.close(1011, "Notification unavailable."); } catch { /* Already disconnected. */ } }
    }
  }
  close(): void {
    if (typeof this.state.getWebSockets !== "function") return;
    let sockets: DurableSocket[];
    try { sockets = this.state.getWebSockets(NOTIFICATION_PROTOCOL); }
    catch { return; /* Auxiliary transport failure cannot change a committed operation. */ }
    for (const socket of sockets)
      try { socket.close(1000, "Notification session replaced."); } catch { /* Already disconnected. */ }
  }
  webSocketMessage(socket: DurableSocket, _message: string | ArrayBuffer): void {
    // The channel accepts no application input, effects or authority claims.
    try { socket.close(1008, "Notifications are server-only."); } catch { /* Already disconnected. */ }
  }
  webSocketClose(socket: DurableSocket, code: number): void {
    try { socket.close(code >= 1000 && code < 5000 && ![1004, 1005, 1006, 1015].includes(code) ? code : 1000); }
    catch { /* Already disconnected. */ }
  }
  webSocketError(socket: DurableSocket): void {
    try { socket.close(1011, "Notification unavailable."); } catch { /* Already disconnected. */ }
  }
}
