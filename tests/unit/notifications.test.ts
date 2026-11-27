import test from "node:test";
import assert from "node:assert/strict";
import { NotificationChannel, type NotificationSocket } from "../../apps/userscript/src/notifications.js";

class FakeSocket implements NotificationSocket {
  readyState = 0;
  protocol = "perch-notify-v1";
  onopen: NotificationSocket["onopen"] = null;
  onmessage: NotificationSocket["onmessage"] = null;
  onerror: NotificationSocket["onerror"] = null;
  onclose: NotificationSocket["onclose"] = null;
  closes = 0;
  close(): void { this.closes++; this.readyState = 3; }
  message(type: string): void { this.onmessage?.({ data: JSON.stringify({ version: 1, type }) } as MessageEvent); }
  ready(): void { this.readyState = 1; this.onopen?.({} as Event); this.message("ready"); }
  lost(): void { this.readyState = 3; this.onclose?.({} as CloseEvent); }
}
function fixture() {
  let now = 1_800_000_000_000, next = 1, requests = 0, quotaDelay = 0;
  const timers = new Map<number, { due: number; fn(): void }>();
  const sockets: FakeSocket[] = [], protocols: string[][] = [], urls: string[] = [];
  const time = {
    now: () => now, random: () => 0,
    setTimeout: (fn: () => void, ms: number) => {
      const id = next++; timers.set(id, { due: now + ms, fn });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (id: ReturnType<typeof setTimeout>) => { timers.delete(id as unknown as number); },
  };
  const channel = new NotificationChannel({
    url: "wss://fixture.workers.dev/api/v1/tab/socket?workspaceId=workspace",
    requestTicket: async () => {
      requests++;
      return { version: 1, protocol: "perch-notify-v1", ticket: "t".repeat(43), expiresAt: now + 30_000 };
    },
    socket: (url, offered) => {
      urls.push(url); protocols.push(offered); const socket = new FakeSocket(); sockets.push(socket); return socket;
    },
    retryDelayMs: () => quotaDelay, clock: time,
  });
  async function connected() {
    const pending = channel.connectIfDue(); await Promise.resolve();
    sockets.at(-1)!.ready(); await pending;
  }
  const advance = (ms: number) => {
    now += ms;
    for (const [id, timer] of [...timers]) if (timer.due <= now) { timers.delete(id); timer.fn(); }
  };
  return { channel, connected, sockets, urls, protocols, advance, requests: () => requests,
    timers: () => timers.size, quota: (ms: number) => { quotaDelay = ms; } };
}
test("notification tickets stay out of URLs; healthy idle creates no periodic fetch or timer", async () => {
  const f = fixture();
  await f.connected();
  assert.equal(f.channel.healthy, true);
  assert.equal(f.timers(), 0);
  assert.equal(f.requests(), 1);
  assert.ok(!f.urls[0]!.includes("t".repeat(43)));
  assert.deepEqual(f.protocols[0], ["perch-notify-v1", "ticket." + "t".repeat(43)]);
  f.advance(8 * 60 * 60 * 1000);
  assert.equal(f.requests(), 1);
  f.channel.stop();
});
test("duplicate signals coalesce and a signal during fetch cannot be lost", async () => {
  const f = fixture(); await f.connected();
  const beforeFetch = f.channel.revision;
  f.sockets[0]!.message("available"); f.sockets[0]!.message("available");
  await f.channel.wait(beforeFetch);
  let woke = false;
  const stable = f.channel.wait(f.channel.revision).then(() => { woke = true; });
  await Promise.resolve(); assert.equal(woke, false);
  f.channel.reconcile(false); await Promise.resolve(); assert.equal(woke, false);
  f.channel.reconcile(true); await stable; assert.equal(woke, true);
  f.channel.stop();
});
test("disconnect requests immediate HTTP fallback before a bounded reconnect", async () => {
  const f = fixture(); await f.connected();
  const waiting = f.channel.wait(f.channel.revision);
  f.sockets[0]!.lost(); await waiting;
  assert.equal(f.channel.healthy, false); assert.equal(f.channel.immediateFallback, true);
  f.advance(60_000); await f.channel.connectIfDue(); assert.equal(f.requests(), 1);
  f.channel.fetched(); await f.connected(); assert.equal(f.requests(), 2);
  // The old generation cannot wake or close the replacement socket.
  f.sockets[0]!.message("available"); f.sockets[0]!.lost();
  assert.equal(f.channel.healthy, true);
  f.channel.stop();
});
test("handshake timeout cancels exactly one attempt and preserves quota backoff", async () => {
  const f = fixture(); f.quota(300_000);
  const one = f.channel.connectIfDue(), two = f.channel.connectIfDue();
  assert.equal(one, two); await Promise.resolve();
  assert.equal(f.requests(), 1); f.advance(10_000); await one;
  assert.equal(f.channel.healthy, false); assert.equal(f.sockets[0]!.closes, 1);
  f.advance(299_999); await f.channel.connectIfDue(); assert.equal(f.requests(), 1);
  f.advance(1); const retry = f.channel.connectIfDue(); await Promise.resolve();
  assert.equal(f.requests(), 2); f.channel.stop(); await retry;
  assert.equal(f.timers(), 0);
});
test("unexpected socket data fails closed, and stopping cancels pending wait", async () => {
  const f = fixture(); await f.connected();
  const wait = f.channel.wait(f.channel.revision);
  f.sockets[0]!.onmessage?.({ data: JSON.stringify({ version: 1, type: "available", args: "private" }) } as MessageEvent);
  await wait; assert.equal(f.channel.healthy, false);
  f.advance(60_000); f.channel.fetched(); await f.connected();
  const stopped = f.channel.wait(f.channel.revision); f.channel.stop(); await stopped;
  assert.equal(f.timers(), 0); assert.equal(f.channel.healthy, false);
});
test("CSP or unsupported socket factory failure falls back without retaining a timer", async () => {
  let tickets = 0;
  const channel = new NotificationChannel({
    url: "wss://fixture.workers.dev/api/v1/tab/socket?workspaceId=workspace",
    requestTicket: async () => { tickets++; return { version: 1, protocol: "perch-notify-v1", ticket: "t".repeat(43), expiresAt: Date.now() + 30_000 }; },
    socket: () => { throw new DOMException("Synthetic policy rejection.", "SecurityError"); },
  });
  await channel.connectIfDue(); assert.equal(channel.healthy, false);
  await channel.connectIfDue(); assert.equal(tickets, 1); channel.stop();
});
test("notification message types require exact strings without coercion", async () => {
  for (const type of [["available"], ["ready"], null, {}, 1]) {
    const f = fixture(); await f.connected();
    f.sockets[0]!.onmessage?.({ data: JSON.stringify({ version: 1, type }) } as MessageEvent);
    assert.equal(f.channel.healthy, false); f.channel.stop();
  }
});
