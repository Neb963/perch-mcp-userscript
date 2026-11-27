const PROTOCOL = "perch-notify-v1";
export interface NotificationTicket { version: 1; protocol: string; ticket: string; expiresAt: number }
export interface NotificationSocket {
  readonly readyState: number;
  readonly protocol: string;
  onopen: ((event: Event) => unknown) | null;
  onmessage: ((event: MessageEvent) => unknown) | null;
  onerror: ((event: Event) => unknown) | null;
  onclose: ((event: CloseEvent) => unknown) | null;
  close(code?: number, reason?: string): void;
}
interface Clock {
  now(): number;
  random(): number;
  setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}
const clock: Clock = {
  now: () => Date.now(), random: () => Math.random(),
  setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: timer => clearTimeout(timer),
};

/** One connection and one waiter per lease. Only the controller fetches work. */
export class NotificationChannel {
  private socket?: NotificationSocket;
  private stopped = false;
  private connected = false;
  private generation = 0;
  private failures = 0;
  private nextAttemptAt = 0;
  private pending?: Promise<void>;
  private finishConnect?: () => void;
  private handshakeAbort?: AbortController;
  private handshakeTimer?: ReturnType<typeof setTimeout>;
  private waiter?: () => void;
  private wakeRevision = 0;
  private fallbackRequired = false;
  private attempts = 0;
  private lastFailureCode?: string;
  constructor(private readonly options: {
    url: string;
    requestTicket(signal: AbortSignal): Promise<NotificationTicket>;
    socket(url: string, protocols: string[]): NotificationSocket;
    retryDelayMs?(): number;
    clock?: Clock;
  }) {}
  get healthy(): boolean { return !this.stopped && this.connected; }
  get revision(): number { return this.wakeRevision; }
  get immediateFallback(): boolean { return this.fallbackRequired; }
  diagnostics() {
    return { state: this.stopped ? "stopped" : this.connected ? "connected" : "fallback",
      attempts: this.attempts, consecutiveFailures: this.failures,
      retryInMs: Math.max(0, this.nextAttemptAt - this.time.now()),
      lastFailureCode: this.lastFailureCode ?? null };
  }
  private get time(): Clock { return this.options.clock ?? clock; }
  private changed(): void {
    this.wakeRevision++;
    this.waiter?.();
  }
  reconcile(workAvailable: boolean): void { if (workAvailable && !this.stopped) this.changed(); }
  fetched(): void { this.fallbackRequired = false; }
  /** Called between HTTP fetches, never in parallel with a paced fallback poll. */
  connectIfDue(): Promise<void> {
    if (this.stopped || this.healthy || this.fallbackRequired || this.time.now() < this.nextAttemptAt)
      return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = this.connect().finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private detach(socket: NotificationSocket): void {
    socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
  }
  private clearHandshake(): void {
    if (this.handshakeTimer !== undefined) this.time.clearTimeout(this.handshakeTimer);
    this.handshakeTimer = undefined;
    this.handshakeAbort?.abort();
    this.handshakeAbort = undefined;
  }
  private failed(generation: number, code: string): void {
    if (this.stopped || generation !== this.generation) return;
    this.generation++;
    this.lastFailureCode = code;
    const wasConnected = this.connected;
    this.connected = false;
    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      this.detach(socket);
      try { socket.close(1000, "Notification fallback."); } catch { /* Transport already closed. */ }
    }
    this.clearHandshake();
    this.failures = Math.min(10, this.failures + 1);
    const backoff = Math.min(60_000, 1000 * 2 ** (this.failures - 1));
    const jittered = backoff * (0.8 + this.time.random() * 0.2);
    this.nextAttemptAt = this.time.now() + Math.max(jittered, Math.min(300_000, this.options.retryDelayMs?.() ?? 0));
    this.fallbackRequired ||= wasConnected;
    this.finishConnect?.();
    this.finishConnect = undefined;
    this.changed();
  }
  private connect(): Promise<void> {
    const generation = ++this.generation;
    this.attempts++;
    this.handshakeAbort = new AbortController();
    const signal = this.handshakeAbort.signal;
    return new Promise<void>(resolve => {
      this.finishConnect = resolve;
      let stage = "TICKET";
      this.handshakeTimer = this.time.setTimeout(() => this.failed(generation, "HANDSHAKE_TIMEOUT"), 10_000);
      void this.options.requestTicket(signal).then(ticket => {
        if (this.stopped || generation !== this.generation) return;
        if (ticket.version !== 1 || ticket.protocol !== PROTOCOL || !/^[A-Za-z0-9_-]{43}$/.test(ticket.ticket) ||
            !Number.isSafeInteger(ticket.expiresAt) || ticket.expiresAt <= this.time.now() ||
            ticket.expiresAt > this.time.now() + 60_000) { this.failed(generation, "INVALID_TICKET"); return; }
        stage = "SOCKET";
        const socket = this.options.socket(this.options.url, [PROTOCOL, "ticket." + ticket.ticket]);
        this.socket = socket;
        socket.onopen = () => {
          if (this.stopped || generation !== this.generation || this.socket !== socket) return;
          if (socket.protocol !== PROTOCOL) this.failed(generation, "PROTOCOL_MISMATCH");
        };
        socket.onmessage = event => {
          if (this.stopped || generation !== this.generation || this.socket !== socket) return;
          if (typeof event.data !== "string" || event.data.length > 96) { this.failed(generation, "INVALID_MESSAGE"); return; }
          let message: unknown;
          try { message = JSON.parse(event.data); } catch { this.failed(generation, "INVALID_MESSAGE"); return; }
          if (!message || typeof message !== "object" || Array.isArray(message) ||
              Object.keys(message).length !== 2 || !("version" in message) || message.version !== 1 ||
              !("type" in message) || typeof message.type !== "string" || !["ready", "available"].includes(message.type)) {
            this.failed(generation, "INVALID_MESSAGE"); return;
          }
          if (message.type === "ready") {
            this.connected = true;
            this.failures = 0;
            this.lastFailureCode = undefined;
            this.clearHandshake();
            this.finishConnect?.();
            this.finishConnect = undefined;
          } else if (!this.connected) { this.failed(generation, "PROTOCOL_ORDER"); return; }
          this.changed();
        };
        socket.onerror = () => this.failed(generation, "SOCKET_ERROR");
        socket.onclose = () => this.failed(generation, "SOCKET_CLOSED");
      }).catch(() => this.failed(generation, stage === "TICKET" ? "TICKET_UNAVAILABLE" : "SOCKET_UNAVAILABLE"));
    });
  }
  /** A changed revision closes the subscribe/snapshot race; at most one waiter. */
  wait(observedRevision: number, signal?: AbortSignal): Promise<void> {
    if (!this.healthy || observedRevision !== this.wakeRevision || signal?.aborted) return Promise.resolve();
    if (this.waiter) throw new Error("Notification wait already pending.");
    return new Promise<void>(resolve => {
      const done = () => {
        if (this.waiter === done) this.waiter = undefined;
        signal?.removeEventListener("abort", done);
        resolve();
      };
      this.waiter = done;
      signal?.addEventListener("abort", done, { once: true });
    });
  }
  stop(): void {
    this.stopped = true;
    this.generation++;
    this.connected = false;
    this.clearHandshake();
    this.finishConnect?.();
    this.finishConnect = undefined;
    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      this.detach(socket);
      try { socket.close(1000, "Notification session stopped."); } catch { /* Already closed. */ }
    }
    this.changed();
  }
}
