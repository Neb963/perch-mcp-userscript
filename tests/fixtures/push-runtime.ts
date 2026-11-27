// Synthetic local entrypoint only. Never packaged or deployed.
import { AsyncLocalStorage } from "node:async_hooks";
import worker, { Registry, Workspace as ActualWorkspace } from "../../apps/gateway/src/index.js";
import type { DurableObjectState, WebSocket as DurableSocket } from "@cloudflare/workers-types";
import type { Env } from "../../apps/gateway/src/common.js";
export { Registry };
const clock = new AsyncLocalStorage<number>(), realNow = Date.now.bind(Date);
Date.now = () => clock.getStore() ?? realNow();
export class Workspace {
  private inner: ActualWorkspace;
  private now?: number;
  private failTicketWrite = false;
  private readonly wrappedState: DurableObjectState;
  private readonly metrics = { starts: 1, sqlReads: 0, sqlWrites: 0, sqlFailures: 0, socketUpgrades: 0, incomingMessages: 0 };
  constructor(state: DurableObjectState, private readonly env: Env) {
    const sql = new Proxy(state.storage.sql, { get: (target, key) => {
      if (key === "exec") return (query: string, ...args: (string | number | null | ArrayBuffer)[]) => {
        if (this.failTicketWrite && /^INSERT/i.test(query) && args.includes("push-state/v1")) {
          this.failTicketWrite = false; this.metrics.sqlFailures++; throw new Error("exceeded allowed rows written in durable objects free tier");
        }
        const cursor = target.exec(query, ...args);
        return new Proxy(cursor, { get: (value, property) => {
          if (property === "toArray") return () => {
            try { return value.toArray(); }
            finally { this.metrics.sqlReads += value.rowsRead; this.metrics.sqlWrites += value.rowsWritten; }
          };
          const method = Reflect.get(value, property, value);
          return typeof method === "function" ? method.bind(value) : method;
        } });
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const storage = new Proxy(state.storage, { get: (target, key) => {
      if (key === "sql") return sql;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    this.wrappedState = new Proxy(state, { get: (target, key) => {
      if (key === "storage") return storage;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    this.inner = new ActualWorkspace(this.wrappedState, env);
  }
  private run<T>(fn: () => T): T { return this.now === undefined ? fn() : clock.run(this.now, fn); }
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/__fixture_push") {
      if (request.method === "POST") {
        const body = await request.json() as { now?: number; restart?: boolean; failTicketWrite?: boolean };
        if (body.now !== undefined) this.now = body.now;
        if (body.failTicketWrite !== undefined) this.failTicketWrite = body.failTicketWrite;
        if (body.restart) { this.inner = this.run(() => new ActualWorkspace(this.wrappedState, this.env)); this.metrics.starts++; }
      }
      return Response.json(this.metrics);
    }
    const response = await this.run(() => this.inner.fetch(request));
    if (response.status === 101) this.metrics.socketUpgrades++;
    return response;
  }
  alarm(): Promise<void> { return this.run(() => this.inner.alarm()); }
  webSocketMessage(socket: DurableSocket, message: string | ArrayBuffer): void {
    this.metrics.incomingMessages++;
    this.run(() => this.inner.webSocketMessage(socket, message));
  }
  webSocketClose(socket: DurableSocket, code: number, reason: string, clean: boolean): void {
    this.run(() => this.inner.webSocketClose(socket, code, reason, clean));
  }
  webSocketError(socket: DurableSocket, error: unknown): void {
    this.run(() => this.inner.webSocketError(socket, error));
  }
}
export default worker;
