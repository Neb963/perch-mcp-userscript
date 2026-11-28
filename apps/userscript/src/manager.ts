import { v2Permissions, v2DefaultPermissions } from '../../../packages/contracts/src/target.js';
import { managerStyles } from "./manager.css";
/** The visible Connector view watches briefly for user-initiated consent,
 * never polls an idle Gateway indefinitely or retries a failed quota forever. */
export function approvalPollingDelay(pending: number, elapsedMs: number,
  failedAttempts: number, quotaDelayMs = 0): number | null {
  if (failedAttempts >= 5 || (failedAttempts === 0 && pending === 0 && elapsedMs >= 30_000))
    return null;
  return Math.max(quotaDelayMs, failedAttempts
    ? Math.min(60_000, 4000 * 2 ** Math.min(failedAttempts, 4)) : 4000);
}
import type { HistoricalRecoveryInspection, HistoricalRecoveryScope } from "./historical-recovery.js";
import { validatePublicFetchUrl } from "./public-fetch.js";
export interface ManagerIdentity {
  generatorId: string;
  slug: string;
  publicId?: string;
  draftId: string;
  browserInstallationId?: string;
}
export interface ManagerConfiguration {
  origin: string;
  paired: boolean;
  browserInstallationId?: string;
}
export interface WorkspaceTransitionReceipt {
  workspaceId: string;
  action: string;
  key: string;
}
interface RestoreIntent {
  mode: "exact-binding" | "source-only";
  expectedRevision: string;
  archiveSha256: string;
}
interface LocalCheckpointSummary {
  id: string;
  label?: string;
  revision: string;
  createdAt: number;
  pinned: boolean;
}
interface PrivateFileSummary {
  id: string;
  path: string;
  bytes: number;
  sha256: string;
  state: string;
}
export interface ManagerClient {
  /** Adds management credential, JSON type and a fresh Idempotency-Key for writes. Never redirects credentials. */
  request(method: string, path: string, body?: unknown,
    options?: {signal?: AbortSignal; idempotencyKey?: string}): Promise<unknown>;
  bindingProof?(workspace: Record<string,unknown>, binding: ManagerIdentity): Promise<unknown>;
  transitionReceipts?: {
    list(): Promise<WorkspaceTransitionReceipt[]>;
    retain(receipt: WorkspaceTransitionReceipt): Promise<void>;
    retire(key: string): Promise<void>;
  };
  health(origin?: string): Promise<unknown>;
  /** Read-only, bounded redacted local request outcomes; never returns credentials. */
  diagnostics?(): unknown;
  probe?(): Promise<unknown>;
  fetchHosts?(): Promise<string[]>;
  setFetchHosts?(hosts: string[]): Promise<void>;
  disconnect?(): Promise<void>;
  importSettings?(settings: {
    schemaVersion: 1;
    gatewayOrigin: string;
  }): Promise<void>;
  reconcileOperation?(
    operation: Record<string, unknown> & {
      operatorEvidence: string;
    },
  ): Promise<void>;
  exportWorkspaceEvidence?(workspaceId:string):Promise<string>;
  localRecovery?(workspaceId:string):Promise<{
    revision:string;sourceError?:string;
    holds:Array<{id:string;kind:string;state:string;createdAt:number;paths:string[];baseRevision:string}>;
  }>;
  localRecoveryScopes?(): Promise<HistoricalRecoveryScope[]>;
  inspectLocalRecovery?(scopeId:string): Promise<HistoricalRecoveryInspection>;
  exportLocalRecovery?(scopeId:string): Promise<string>;
  resolveRetainedLocalHold?(scopeId:string,recordId:string,expectedInspection:string,evidence:string):Promise<void>;
  listCheckpoints?(scopeId: string): Promise<LocalCheckpointSummary[]>;
  exportCheckpoint?(scopeId: string, checkpointId: string): Promise<string>;
  setCheckpointPinned?(scopeId: string, checkpointId: string, pinned: boolean): Promise<void>;
  stagePrivateFile?(path: string, bytes: Uint8Array): Promise<{id:string;sha256:string;bytes:number}>;
  listPrivateFiles?(): Promise<PrivateFileSummary[]>;
  previewPrivateFileImport?(id: string): Promise<{expectedLocalRevision: string; path: string; bytes: number; sha256: string}>;
  importPrivateFile?(id: string, expectedLocalRevision: string): Promise<{localRevision: string}>;
  previewSourceRestore?(archive: unknown, mode: RestoreIntent["mode"]): Promise<RestoreIntent & {fileCount:number}>;
  resolveLocalHold?(workspaceId:string,journalId:string,expectedRevision:string,evidence:string):Promise<void>;
  localArtifacts?(): Promise<
    {
      id: string;
      name: string;
      workspaceId: string;
      bytes: number;
      createdAt: number;
    }[]
  >;
  downloadArtifact?(id: string): Promise<void>;
  /** Must use an isolated native browser credential prompt, never document inputs. */
  promptSecret?(purpose: "bootstrap" | "recovery"): Promise<string | null>;
  pair(origin: string, secret: string): Promise<void>;
  recover?(origin: string, secret: string): Promise<void>;
  configuration(): ManagerConfiguration;
  currentIdentity(): Promise<ManagerIdentity>;
  attach?(workspace: Record<string, unknown>): Promise<void>;
  pauseLocal?(): Promise<void> | void;
  copy(text: string): Promise<void>;
  drafts?: {
    get(key: string): Promise<string | undefined>;
    set(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
  };
  download(name: string, data: string | Uint8Array, mime: string): void;
  /** Source backup belongs to the browser VFS; never mixed with Library/settings export. */
  sourceBackup?(): Promise<unknown>;
  /** Separate unpublished Resource drafts from every retained document; controller excludes credentials. */
  localDrafts?(): Promise<unknown>;
  restoreSourceBackup?(backup: unknown, intent?: RestoreIntent): Promise<void>;
  importPreview?(bytes: Uint8Array): Promise<unknown>;
  /** Supplied only when binary request handling is needed; normal JSON responses use request(). */
  exportResources?(): Promise<Uint8Array>;
}
export interface ManagerOptions {
  document?: Document;
  root?: HTMLElement;
  version: string;
  client: ManagerClient;
  onError?(error: unknown): void;
  /** Fixture-only: opens the ShadowRoot and accepts synthetic DOM events. Never set by the production entry point. */
  synthetic?: true;
}
export interface ManagerStatus {
  connection: "unpaired" | "connecting" | "connected" | "degraded" | "paused" | "offline" | "blocked";
  workspace?: string;
  agent?: string;
  dirty?: boolean;
  revision?: string;
  reason?: string;
}
export interface ManagerHandle {
  open(tab?: Tab): Promise<void>;
  close(): void;
  destroy(): void;
  refresh(): Promise<void>;
  setStatus(status: ManagerStatus): void;
}
type Tab = "Workspaces" | "Agents" | "Activity" | "Recovery" | "Settings";
type Row = Record<string, unknown>;
interface List {
  items: Row[];
  revision: number;
  cursor?: string | null;
}
const ADMIN = "/api/v1/admin";
const PERMISSIONS = [
  "READ_SOURCE",
  "WRITE_SOURCE",
  "PREVIEW_CONTROL",
  "PREVIEW_EXECUTE",
  "COMPUTE",
  "FETCH_PUBLIC",
  "FETCH_POST",
  "SAVE",
  "CREATE",
  "RENAME",
  "DUPLICATE",
  "LISTING",
  "DELETE",
  "MEDIA",
  "UPLOAD_PUBLIC",
  "PRODUCTION_READ",
  "PRODUCTION_RESTORE",
  "EXPORT_ARTIFACT",
  "READ_RESOURCES",
];
const DEFAULT_PERMISSIONS = [
  "READ_SOURCE",
  "WRITE_SOURCE",
  "PREVIEW_CONTROL",
  "READ_RESOURCES",
];
const isRecord = (v: unknown): v is Row =>
  !!v && typeof v === "object" && !Array.isArray(v);
const record = (v: unknown): Row => (isRecord(v) ? v : {});
const str = (v: unknown, fallback = ""): string =>
  typeof v === "string" ? v : typeof v === "number" ? String(v) : fallback;
const num = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) ? v : 0;
const list = (v: unknown): List => {
  const r = record(v);
  return {
    items: Array.isArray(r.items) ? r.items.filter(isRecord) : [],
    revision: num(r.revision),
    cursor: typeof r.cursor === "string" ? r.cursor : null,
  };
};
const arrayStrings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
function errorText(e: unknown): string {
  const r = record(e);
  return `${str(r.code, "REQUEST_FAILED")}: ${e instanceof Error ? e.message : str(r.message, "The request could not be completed.")} ${str(r.recovery)}`.trim();
}
function endpoint(origin: string, agent: Row): string {
  return `${origin}/mcp/${encodeURIComponent(str(agent.id))}`;
}
function validateOrigin(value: string): string {
  const url = new URL(value.trim());
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  )
    throw new Error(
      "Enter an HTTPS origin without a path, credentials, query, or fragment.",
    );
  return url.origin;
}
export function lineDiff(
  before: string,
  after: string,
): {
  kind: "same" | "remove" | "add";
  text: string;
}[] {
  const a = before.split("\n"),
    b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (
    end < a.length - start &&
    end < b.length - start &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  )
    end++;
  return [
    ...a
      .slice(Math.max(0, start - 3), start)
      .map((text) => ({ kind: "same" as const, text })),
    ...a
      .slice(start, a.length - end)
      .map((text) => ({ kind: "remove" as const, text })),
    ...b
      .slice(start, b.length - end)
      .map((text) => ({ kind: "add" as const, text })),
    ...a
      .slice(a.length - end, a.length - end + 3)
      .map((text) => ({ kind: "same" as const, text })),
  ].slice(0, 2000);
}
/** No HTML parsing, remote images, event attributes, or active links in a Resource preview. */
export function renderResourcePreview(
  doc: Document,
  source: string,
): HTMLElement {
  const out = doc.createElement("div");
  for (const line of source.split("\n").slice(0, 5000)) {
    const match = /^(#{1,3})\s+(.+)$/.exec(line);
    const node = doc.createElement(
      match ? `h${Math.min(3, match[1]!.length + 1)}` : "p",
    );
    node.textContent = match ? match[2]! : line;
    out.append(node);
  }
  return out;
}
export function exportSafeSettings(
  configuration: ManagerConfiguration,
  version: string,
): string {
  return json({
    schemaVersion: 1,
    version,
    gatewayOrigin: configuration.origin,
    requiresPairing: true,
    requiresRebind: true,
  });
}
/**
 * A diagnostic report is independent of MCP Activity; OAuth events are not
 * operations. Always produce a useful file even when the gateway is offline.
 * Only allowlisted scalar projections are ever exported.
 */
export async function buildDiagnosticReport(
  client: ManagerClient,
  version: string,
  current?: ManagerStatus,
  localOnly = false,
): Promise<Record<string, unknown>> {
  const config = client.configuration();
  const get = async (task: () => Promise<unknown>) => {
    try { return { ok: true, value: await task() }; }
    catch (error) {
      const r = record(error);
      return {
        ok: false,
        code: /^[A-Z][A-Z0-9_]{0,47}$/.test(str(r.code)) ? r.code : "REQUEST_FAILED",
        status: num(r.status),
        traceId: /^[0-9a-f-]{36}$/.test(str(r.traceId)) ? r.traceId : undefined,
      };
    }
  };
  const omitted = {ok:false,code:"LOCAL_ONLY",status:0,traceId:undefined};
  const [health, stateResult, remote] = localOnly ? [omitted,omitted,omitted] : await Promise.all([
    get(() => client.health()),
    get(() => client.request("GET", `${ADMIN}/state`)),
    get(() => client.request("GET", `${ADMIN}/diagnostics`)),
  ]);
  const safeHealth = record("value" in health ? health.value : undefined),
    safeState = record("value" in stateResult ? stateResult.value : undefined);
  const rawEvents = record("value" in remote ? remote.value : undefined).events;
  const approvedRoutes = new Set(["authorize", "authorize_complete", "token", "register"]);
  const approvedOrigins = new Set(["missing", "null", "same", "perchance", "chatgpt", "other"]);
  const events = Array.isArray(rawEvents) ? rawEvents.slice(-100).filter(isRecord)
    .map((event) => ({
      at: num(event.at),
      route: approvedRoutes.has(str(event.route)) ? event.route : "other",
      method: ["GET", "POST"].includes(str(event.method)) ? event.method : "other",
      originClass: approvedOrigins.has(str(event.originClass)) ? event.originClass : "other",
      status: num(event.status),
      code: /^[A-Z_][A-Z0-9_]{0,47}$/.test(str(event.code)) ? event.code : "UNKNOWN",
      traceId: /^[0-9a-f-]{36}$/.test(str(event.traceId)) ? event.traceId : undefined,
    })) : [];
  // The gateway's 302 audit means it issued a callback, not that the AI
  // client received or exchanged it. Events are intentionally uncorrelated
  // across requests to avoid recording OAuth handles or authorization codes.
  const lastRedirect = [...events].reverse().find((event) =>
    event.route === "authorize_complete" &&
    ["CALLBACK_REDIRECT_ISSUED", "COMPLETE"].includes(String(event.code)));
  const tokenAfterRedirect = !!lastRedirect && events.some((event) =>
    event.route === "token" && event.at >= lastRedirect.at &&
    (event.code === "TOKEN_EXCHANGE_SUCCEEDED" || (event.status >= 200 && event.status < 300)));
  const fallbackOffered = !!lastRedirect && events.some((event) =>
    event.route === "authorize_complete" && event.at >= lastRedirect.at &&
    event.code === "CALLBACK_RECOVERY_AVAILABLE");
  const local = record(client.diagnostics?.());
  const localEvents = Array.isArray(local.events) ? local.events.slice(-100).filter(isRecord)
    .map((event) => ({
      at: num(event.at),
      method: ["GET", "POST", "PATCH", "PUT", "DELETE"].includes(str(event.method)) ? event.method : "other",
      route: /^\/(?:api\/v1\/(?:admin|tab)\/|health$)/.test(str(event.route))
        ? str(event.route).split("?")[0]!.slice(0, 120)
            .replace(/\/(workspaces|agents|approvals|grants|resources)\/[^/]+/g, "/$1/:id")
            .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ":id")
        : "redacted",
      status: num(event.status),
      elapsedMs: num(event.elapsedMs),
      code: /^[A-Z_][A-Z0-9_]{0,47}$/.test(str(event.code)) ? event.code : "UNKNOWN",
      traceId: /^[0-9a-f-]{36}$/.test(str(event.traceId)) ? event.traceId : undefined,
    })) : [];
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    purpose: "OAuth, connection and management diagnostics. No source, tokens or credentials.",
    userscriptVersion: version,
    gatewayOrigin: config.origin,
    paired: config.paired,
    manager: {
      connection: current?.connection ?? "unknown",
      workspaceSelected: !!current?.workspace,
      // Exact errors are projected to stable codes, not raw native/provider text.
      reasonCode: (()=>{
        const match=/\(([A-Z_]{3,48})\)/.exec(current?.reason??'');
        return match?match[1]:null;
      })(),
    },
    health: {
      ok: health.ok,
      ...(!health.ok ? { error: health } : {
        version: str(safeHealth.version, "unknown"),
        schemaVersion: num(safeHealth.schemaVersion),
        configured: safeHealth.configured === true,
        paired: safeHealth.paired === true,
        providerWritesEnabled: safeHealth.providerWritesEnabled === true,
      }),
    },
    registry: {
      ok: stateResult.ok,
      ...(!stateResult.ok ? { error: stateResult } : {
        version: str(safeState.version, "unknown"),
        revision: num(safeState.revision),
        policyRevision: num(safeState.policyRevision),
        paused: safeState.paused === true,
        workspaces: num(safeState.workspaces),
        agents: num(safeState.agents),
        assignmentContractVersion: num(safeState.assignmentContractVersion),
        rollout: (() => {
          const r=record(safeState.rollout);
          return {
            developmentContractV2Enabled:r.developmentContractV2Enabled===true,
            developmentContractV2ExecutionEnabled:r.developmentContractV2ExecutionEnabled===true,
            canonicalStorageMode:['legacy','prepare','native'].includes(str(r.canonicalStorageMode))
              ?r.canonicalStorageMode:'unknown',
            pushNotificationsEnabled:r.pushNotificationsEnabled===true,
            binaryPayloadsEnabled:r.binaryPayloadsEnabled===true,
            admissionBudgetEnabled:r.admissionBudgetEnabled===true,
          };
        })(),
      }),
    },
    oauthAudit: { ok: remote.ok, ...(!remote.ok ? { error: remote } : {}), events },
    oauthHandoff: {
      lastRedirectIssuedAt: lastRedirect?.at ?? null,
      tokenExchangeObservedAfterLastRedirect: tokenAfterRedirect,
      manualCallbackRecoveryOffered: fallbackOffered,
      evidenceLimit: "Server events do not identify the client or confirm navigation. Absence of a token exchange is not proof of a blocked client.",
    },
    transport: {
      events: localEvents,
      preservedFailures: Array.isArray(local.preservedFailures)
        ? local.preservedFailures.slice(-256).filter(isRecord).map(event => ({
            at: num(event.at),
            method: ['GET','POST','PUT','PATCH','DELETE','STATE'].includes(str(event.method)) ? event.method : 'other',
            route: /^\/(?:api\/v1\/(?:admin|tab)\/|health|local\/)/.test(str(event.route))
              ? str(event.route).slice(0,120)
                  .replace(/\/(workspaces|agents|approvals|grants|resources)\/[^/]+/g, '/$1/:id')
                  .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ':id') : 'redacted',
            code: /^[A-Z0-9_:]{1,100}$/.test(str(event.code)) ? event.code : 'UNKNOWN',
            status: num(event.status),
            elapsedMs: num(event.elapsedMs),
            traceId: /^[0-9a-f-]{36}$/.test(str(event.traceId)) ? event.traceId : undefined,
          })) : [],
    },
    preview: {
      events: (() => {
        const events = record(local.preview).previewEvents;
        return Array.isArray(events) ? events.slice(-50).filter(isRecord).map((event) => ({
          at: num(event.at),
          tool: ['page_eval', 'page_refresh', 'preview_diagnostics', 'set_viewport_size', 'capture_page_image']
            .includes(str(event.tool)) ? event.tool : 'other',
          durationMs: num(event.durationMs),
          outcome: event.outcome === 'ok' ? 'ok' : 'error',
          code: /^[A-Z][A-Z0-9_]{0,47}$/.test(str(event.code)) ? event.code : 'UNKNOWN',
        })) : [];
      })(),
      scope: 'Local preview operation outcomes only. Never contains generator JavaScript, console text or OAuth credentials.',
    },
    browser: (() => {
      const b = record(local.browser);
      const connection = str(b.connection);
      return {
        connection: ["unpaired", "connecting", "connected", "degraded", "paused", "offline", "blocked"].includes(connection) ? connection : "unknown",
        leasePresent: b.leasePresent === true,
        leaseRemainingMs: num(b.leaseRemainingMs),
        stopped: b.stopped === true,
        consecutivePollFailures: num(b.consecutivePollFailures),
        lastPollSuccessAt: typeof b.lastPollSuccessAt === "number" ? b.lastPollSuccessAt : null,
        reasonCode: /^[A-Z][A-Z0-9_]{0,47}$/.test(str(b.reasonCode)) ? b.reasonCode : null,
        attachFailureCode: /^[A-Z][A-Z0-9_]{0,47}$/.test(str(b.attachFailureCode)) ? b.attachFailureCode : null,
        failureStage: /^[A-Z][A-Z0-9_]{0,47}$/.test(str(b.failureStage)) ? b.failureStage : null,
        bootstrapPhase: /^[A-Z][A-Z0-9_]{0,47}$/.test(str(b.bootstrapPhase)) ? b.bootstrapPhase : null,
        bootstrapCode: /^[A-Z][A-Z0-9_]{0,47}$/.test(str(b.bootstrapCode)) ? b.bootstrapCode : null,
        bootstrapWorkspaceSelected: typeof b.bootstrapWorkspace==='string',
        reconnectPending: b.reconnectPending===true,
        reconnectAttempt: Math.max(0,Math.min(1000,num(b.reconnectAttempt))),
      };
    })(),
    note: "OAuth events do not appear in MCP operation Activity; inspect oauthAudit and transport.",
  };
}
export function mountManager(options: ManagerOptions): ManagerHandle {
  const doc = options.document ?? document,
    client = options.client;
  const host = doc.createElement("div");
  host.dataset.perchMcpManager = "1";
  const shadow = host.attachShadow({
    mode: options.synthetic === true ? "open" : "closed",
  });
  const style = doc.createElement("style");
  style.textContent = managerStyles;
  shadow.append(style);
  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    text?: string,
    cls?: string,
  ): HTMLElementTagNameMap[K] => {
    const n = doc.createElement(tag);
    if (text !== undefined) n.textContent = text;
    if (cls) n.className = cls;
    return n;
  };
  const launcher = el("button", "Perch MCP", "launcher");
  launcher.type = "button";
  launcher.setAttribute("aria-label", "Open Perch MCP manager");
  launcher.setAttribute("aria-haspopup", "dialog");
  const dialog = el("dialog");
  dialog.setAttribute("aria-label", "Perch MCP manager");
  const head = el("header", undefined, "head"),
    title = el("h1", "Perch MCP", "title"),
    statusNode = el("span", "Unpaired", "state");
  const nav = el("nav", undefined, "tabs");
  nav.setAttribute("aria-label", "Manager sections");
  const body = el("main", undefined, "body");
  body.tabIndex = -1;
  const foot = el("footer", undefined, "foot"),
    notice = el("span", "", "notice");
  notice.setAttribute("role", "status");
  notice.setAttribute("aria-live", "polite");
  let status: ManagerStatus = {
      connection: client.configuration().paired ? "offline" : "unpaired",
    },
    tab: Tab = client.configuration().paired ? "Workspaces" : "Settings";
  let viewAbort: AbortController | undefined;
  const v2Requests = new Map<string, WorkspaceTransitionReceipt>();
  let receiptInstallation = "";
  const mutationPending = new Set<string>();
  let authority: { generation: number; installation: string } | undefined;
  let remoteAction: { generation: number; installation: string } | undefined;
  const isDocumentHidden=()=>doc.visibilityState==='hidden';
  let approvalRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  function stopApprovalRefresh() {
    if (approvalRefreshTimer !== undefined) clearTimeout(approvalRefreshTimer);
    approvalRefreshTimer = undefined;
  }
  let generation = 0,
    destroyed = false,
    opened = false,
    previousFocus: Element | null = null,
    state: Row = {},
    workspaces: List = { items: [], revision: 0 },
    agents: List = { items: [], revision: 0 };
  let recoveryWorkspaceId = "";
  let retainedScopeId = "";
  let retainedPanel: { own: number; node: HTMLElement } | undefined;
  let filterValue = "";
  const localTables = new Map<HTMLElement, () => void>();
  // Session-local, redacted cache; never used as mutation authority.
  let lastKnown: {installation:string; observedAt:number; workspaces:Row[]; connectors:Row[]; activity:Row[]} | undefined;
  let snapshotInstallation = "";
  let confirmation: { box: HTMLElement; trigger: HTMLElement | null } | undefined;
  const buttons = new Map<Tab, HTMLButtonElement>();
  function fitTextarea(area: HTMLTextAreaElement, minimum = 100) {
    if (!area.isConnected || !area.getClientRects().length) return;
    area.style.height = "auto";
    const computed = doc.defaultView?.getComputedStyle(area);
    const border =
      (Number.parseFloat(computed?.borderTopWidth ?? "") || 0) +
      (Number.parseFloat(computed?.borderBottomWidth ?? "") || 0);
    // scrollHeight includes padding but excludes border; CSS uses border-box sizing.
    area.style.height = `${Math.max(minimum, Math.ceil(area.scrollHeight + border))}px`;
  }
  function fitVisibleTextareas() {
    if (destroyed || !opened) return;
    for (const area of dialog.querySelectorAll<HTMLTextAreaElement>("textarea"))
      fitTextarea(area, Number(area.dataset.autoGrowMinimum) || 100);
  }
  function announce(message: string, error = false) {
    notice.textContent = message;
    notice.className = `notice ${error ? "error" : "success"}`;
  }
  function report(e: unknown) {
    announce(errorText(e), true);
    options.onError?.(e);
  }
  async function run(action: () => Promise<void>, target?: HTMLButtonElement) {
    const view = generation;
    if (target) target.disabled = true;
    try {
      await action();
    } catch (e) {
      if (view===generation || state.assignmentContractVersion!==2) report(e);
    } finally {
      if (target?.isConnected) {
        if (target.hasAttribute("data-remote-mutation")) refreshRemoteButtons();
        else target.disabled = false;
      }
    }
  }
  function on<K extends keyof HTMLElementEventMap>(
    target: EventTarget,
    type: K,
    listener: (event: HTMLElementEventMap[K]) => void,
    capture = false,
  ) {
    target.addEventListener(
      type,
      (event) => {
        if (options.synthetic === true || event.isTrusted)
          listener(event as HTMLElementEventMap[K]);
      },
      capture,
    );
  }
  const buttonActions = new WeakMap<
    HTMLButtonElement,
    () => Promise<void> | void
  >();
  function activateButton(button: HTMLButtonElement) {
    if (button.disabled || !button.isConnected || !opened) return;
    const action = buttonActions.get(button);
    if (action)
      void run(async () => {
        await action();
      }, button);
  }
  function button(
    label: string,
    action: () => Promise<void> | void,
    cls?: string,
  ): HTMLButtonElement {
    const b = el("button", label, cls);
    b.type = "button";
    buttonActions.set(b, action);
    on(b, "click", () => activateButton(b));
    return b;
  }
  function heading(text: string, parent: HTMLElement = body) {
    parent.append(el("h2", text));
  }
  function p(text: string, parent: HTMLElement = body, cls?: string) {
    parent.append(el("p", text, cls));
  }
  function field(
    label: string,
    value = "",
    type = "text",
  ): {
    label: HTMLLabelElement;
    input: HTMLInputElement;
  } {
    const l = el("label", label),
      input = el("input");
    input.type = type;
    input.value = value;
    input.setAttribute("aria-label", label);
    l.append(input);
    return { label: l, input };
  }
  function select(
    label: string,
    values: {
      value: string;
      label: string;
    }[],
    value?: string,
  ): {
    label: HTMLLabelElement;
    input: HTMLSelectElement;
  } {
    const l = el("label", label),
      input = el("select");
    input.setAttribute("aria-label", label);
    for (const item of values) {
      const o = el("option", item.label);
      o.value = item.value;
      input.append(o);
    }
    if (value !== undefined) input.value = value;
    l.append(input);
    return { label: l, input };
  }
  function actions(parent: HTMLElement, ...nodes: HTMLElement[]) {
    const r = el("div", undefined, "actions");
    r.append(...nodes);
    parent.append(r);
    return r;
  }
  function installation() {
    const config = client.configuration();
    return JSON.stringify([config.paired, config.origin, config.browserInstallationId]);
  }
  function requireAuthority(own: number) {
    if (!opened || destroyed || own !== generation ||
        authority?.generation !== own || authority.installation !== installation())
      throw new Error("Gateway authority changed. Refresh this view before taking action.");
  }
  function refreshRemoteButtons() {
    const active = doc.visibilityState !== "hidden" && authority?.generation === generation && authority.installation === installation() && !remoteAction;
    for (const control of body.querySelectorAll<HTMLButtonElement>("[data-remote-mutation]")) {
      control.disabled = !active || control.dataset.unavailable === "true";
    }
  }
  async function runRemoteAction(own: number, action: () => Promise<void>) {
    requireAuthority(own);
    if (remoteAction || confirmation) throw new Error("A management action or confirmation is already pending.");
    const current = { generation: own, installation: installation() };
    remoteAction = current;
    refreshRemoteButtons();
    try {
      await action();
    } catch(error) {
      const detail=record(error);
      if(current.generation===generation && (num(detail.status)===429 || num(detail.status)>=500 || ["NETWORK_ERROR","TIMEOUT","GATEWAY_DEGRADED","AUTH_REQUIRED","UNAUTHORIZED","HTTP_ERROR"].includes(str(detail.code)))) {
        authority=undefined;
        dismissConfirmation();
        renderViewShell("Gateway action outcome is unverified. Inspect the original receipt before another action.");
      }
      throw error;
    } finally {
      if (remoteAction === current) remoteAction = undefined;
      refreshRemoteButtons();
    }
  }
  function markRemote(control: HTMLButtonElement, unavailable = false) {
    control.dataset.remoteMutation = "";
    control.dataset.unavailable = String(unavailable);
    control.disabled = unavailable || remoteAction !== undefined || authority?.generation !== generation;
    return control;
  }
  function remoteButton(label: string, own: number, action: () => Promise<void>, cls?: string) {
    return markRemote(button(label, () => runRemoteAction(own, action), cls));
  }
  function dismissConfirmation(restoreFocus = false) {
    const current = confirmation;
    if (!current) return;
    confirmation = undefined;
    current.box.remove();
    if (restoreFocus && current.trigger?.isConnected) current.trigger.focus();
  }
  function confirmAction(message: string, action: () => Promise<void>, remote = false,
      confirmLabel = "Confirm", parent = body) {
    if (confirmation) {
      confirmation.box.focus();
      return;
    }
    const own = generation;
    if (remote) requireAuthority(own);
    const box = el("div", undefined, "confirm");
    box.setAttribute("role", "alert");
    box.tabIndex = -1;
    const selected = shadow.activeElement;
    const current = { box, trigger: selected && "focus" in selected ? selected as HTMLElement : null };
    confirmation = current;
    p(message, box);
    const confirm = button(confirmLabel, async () => {
      if (confirmation !== current || own !== generation || !opened || destroyed) return;
      dismissConfirmation(true);
      if (remote) await runRemoteAction(own, action);
      else await action();
    }, "danger");
    box.append(
      remote ? markRemote(confirm) : confirm,
      button("Cancel", () => {
        if (confirmation === current) dismissConfirmation(true);
      }),
    );
    if (parent === body) body.prepend(box);
    else parent.append(box);
    box.querySelector("button")?.focus();
  }
  function copy(label: string, value: string) {
    return button(label, async () => {
      await client.copy(value);
      announce("Copied.");
    });
  }
  function setStatus(next: ManagerStatus) {
    const oldConnection = status.connection;
    status = next;
    if (next.connection === "degraded" || next.connection === "unpaired") {
      authority = undefined;
      dismissConfirmation();
      refreshRemoteButtons();
      if (opened && oldConnection !== next.connection) {
        ++generation;
        viewAbort?.abort();
        stopApprovalRefresh();
        renderViewShell("Gateway state is unverified. Refresh to check availability.");
      }
    }
    statusNode.textContent = [
      next.workspace,
      next.agent,
      next.connection,
      next.dirty === undefined
        ? ""
        : next.dirty
          ? "draft changed"
          : "draft unchanged",
      next.revision ? `revision ${next.revision.slice(0, 14)}` : "",
      next.reason,
    ]
      .filter(Boolean)
      .join(" · ");
    launcher.textContent = `Perch MCP · ${next.connection}`;
  }
  function table(
    columns: {
      key: string;
      label: string;
      render?(row: Row, cell: HTMLTableCellElement): void;
    }[],
    rows: Row[],
    parent: HTMLElement = body,
    useFilter = true,
  ) {
    const t = el("table"), thead = el("thead"), tr = el("tr"), tbody = el("tbody");
    let sortField = "label", sortDirection = 1;
    const empty = el("p", "No entries.", "empty");
    const renderRows = () => {
      if (confirmation && t.contains(confirmation.box)) dismissConfirmation();
      tbody.replaceChildren();
      const needle = filterValue.toLocaleLowerCase();
      const selected = rows.filter(r => !useFilter || json(r).toLocaleLowerCase().includes(needle));
      selected.sort((a,b) => str(a[sortField]).localeCompare(str(b[sortField])) * sortDirection);
      for (const row of selected) {
        const r = el("tr");
        for (const c of columns) {
          const td = el("td");
          td.dataset.label=c.label;
          if (c.render) c.render(row, td);
          else td.textContent = str(row[c.key], "—");
          const value=el('div',undefined,'cell-value');
          value.append(...Array.from(td.childNodes));
          td.append(value);
          r.append(td);
        }
        tbody.append(r);
      }
      empty.hidden=selected.length!==0;
      refreshRemoteButtons();
    };
    for (const c of columns) {
      const th = el("th");
      th.scope = "col";
      const b = button(c.label, () => {
        if(confirmation) dismissConfirmation();
        sortDirection = sortField === c.key ? -sortDirection : 1;
        sortField = c.key;
        renderRows();
        for (const header of tr.querySelectorAll("th")) header.removeAttribute("aria-sort");
        th.setAttribute("aria-sort",sortDirection===1?"ascending":"descending");
      });
      b.setAttribute("aria-label", `Sort by ${c.label}`);
      th.append(b);
      tr.append(th);
    }
    thead.append(tr);
    t.append(thead, tbody);
    parent.append(t,empty);
    if (useFilter) localTables.set(t,renderRows);
    renderRows();
  }
  function search(parent = body) {
    const f = field("Filter", filterValue, "search");
    f.label.classList.add("compact-filter");
    const apply = () => {
      if(confirmation) dismissConfirmation();
      filterValue = f.input.value;
      for (const [table,render] of localTables) {
        if (table.isConnected) render();
        else localTables.delete(table);
      }
    };
    on(f.input, "input", apply);
    on(f.input, "change", apply);
    const row = el("div", undefined, "row");
    row.append(f.label, button("Refresh", refresh));
    parent.append(row);
  }
  async function loadList(path: string, signal = viewAbort?.signal): Promise<List> {
    let response = list(await client.request("GET", path, undefined, {signal}));
    const items = [...response.items],
      seen = new Set<string>();
    while (response.cursor) {
      if (seen.has(response.cursor) || items.length >= 2000)
        throw new Error(
          "Management list exceeds its pagination budget. Refine the selection or export the registry.",
        );
      seen.add(response.cursor);
      const next = list(
        await client.request(
          "GET",
          `${path}?cursor=${encodeURIComponent(response.cursor)}`,undefined,{signal},
        ),
      );
      if (next.revision !== response.revision)
        throw new Error(
          "Registry changed while paging. Refresh to load one consistent snapshot.",
        );
      items.push(...next.items);
      response = next;
    }
    return { items, revision: response.revision, cursor: null };
  }
  async function baseData(signal?: AbortSignal) {
    const [raw, w] = await Promise.all([
      client.request("GET", `${ADMIN}/state`,undefined,{signal}),
      loadList(`${ADMIN}/workspaces`,signal),
    ]);
    const s = record(raw);
    const a = await loadList(`${ADMIN}/${s.assignmentContractVersion===2?'connectors':'agents'}`,signal);
    return {s,w,a};
  }
  function tabLabel() {
    return tab === "Agents" ? "Connectors" : tab;
  }
  function cachedRows(view: Tab): Row[] {
    if (!lastKnown || lastKnown.installation!==installation() || Date.now()-lastKnown.observedAt>86400000)
      return [];
    return view==="Workspaces"?lastKnown.workspaces:view==="Agents"?lastKnown.connectors:view==="Activity"?lastKnown.activity:[];
  }
  function rememberBase(scope:string, w:List, a:List) {
    const previous=lastKnown?.installation===scope?lastKnown:undefined;
    lastKnown={installation:scope,observedAt:Date.now(),
      workspaces:w.items.slice(0,100).map(row=>({label:str(row.label).slice(0,120),id:str(row.id).slice(0,128),
        connector:str(a.items.find(c=>c.id===row.connectorId||c.workspaceId===row.id)?.label,"Unassigned").slice(0,120),
        binding:str(record(row.binding).slug,"Unbound").slice(0,120),paused:row.paused===true})),
      connectors:a.items.slice(0,100).map(row=>({label:str(row.label).slice(0,120),id:str(row.id).slice(0,128),
        assignments:num(row.assignmentCount),suspended:row.suspended===true})),
      activity:previous?.activity??[]};
  }
  async function stopLocal() {
    const pending=client.pauseLocal?.();
    setStatus({...status,connection:"paused",reason:"Local stop requested; remote effects may still complete."});
    await pending;
    announce("Local admissions stopped. Previously dispatched effects may still complete.");
  }
  async function exportLocalDiagnostics() {
    const report=await buildDiagnosticReport(client,options.version,status,true);
    client.download("perch-mcp-local-diagnostics.json",json(report),"application/json");
    announce("Local diagnostic report exported. No Gateway request was made.");
  }
  function renderViewShell(message: string) {
    body.replaceChildren();
    localTables.clear();
    if (tab === "Settings") renderSettings();
    else {
      heading(tabLabel());
      p(message, body, "muted");
      actions(body,button("Refresh",refresh),button("Export local diagnostics",exportLocalDiagnostics),
        ...(client.pauseLocal?[button("Stop this document immediately",stopLocal,"danger")]:[]));
      if (tab==="Workspaces") {
        const editor=el("p","Current editor: checking local identity…","muted");
        body.append(editor);
        const own=generation, scope=installation();
        void client.currentIdentity().then(identity=>{
          if(own===generation&&scope===installation()&&editor.isConnected)
            editor.textContent="Current editor: "+identity.slug+" · "+identity.generatorId+" · draft "+(identity.draftId||"(default)");
        }).catch(()=>{if(editor.isConnected)editor.textContent="Current editor identity unavailable.";});
        p("Local connection: "+status.connection+". Native manual editing remains available.",body);
      }
      if (tab==="Agents") {
        const config=client.configuration();
        p("Gateway: "+(config.origin||"not configured")+". Remote authorization status unknown; no revocation inferred.",body);
      }
      if (tab==="Activity") {
        p("Local observations remain available through the diagnostic export and Recovery. Remote operation outcomes are not inferred.",body);
      }
      if (tab === "Recovery") mountRetainedRecovery(generation);
      const rows=cachedRows(tab);
      if(rows.length&&lastKnown){
        heading("Last-known remote snapshot — stale");
        p("Observed "+new Date(lastKnown.observedAt).toISOString()+". Read-only; cannot authorize any action.",body,"muted");
        search();
        const columns=tab==="Workspaces"?[{key:"label",label:"Workspace"},{key:"connector",label:"Connector"},{key:"binding",label:"Last-known Binding"}]:
          tab==="Agents"?[{key:"label",label:"Connector"},{key:"assignments",label:"Assignments"},{key:"suspended",label:"Last-known suspension"}]:
            [{key:"operationId",label:"Operation"},{key:"tool",label:"Tool"},{key:"phase",label:"Last-known outcome"}];
        table(columns,rows);
      } else p("No valid cached remote summary; state is unknown.",body,"muted");
    }
  }
  async function refresh() {
    stopApprovalRefresh();
    dismissConfirmation();
    const own = ++generation;
    authority = undefined;
    viewAbort?.abort();
    viewAbort = new AbortController();
    if (!opened || destroyed) return;
    const scope = installation();
    if(snapshotInstallation!==scope){
      snapshotInstallation=scope;lastKnown=undefined;state={};workspaces={items:[],revision:0};agents={items:[],revision:0};
    }
    updateTabs();
    renderViewShell("Loading management state…");
    announce("Loading…");
    try {
      if (!client.configuration().paired) {
        if (own !== generation) return;
        tab = "Settings";
        updateTabs();
        body.replaceChildren();
        renderSettings();
        announce("Pair this installation to begin.");
        return;
      }
      const base = await baseData(viewAbort.signal);
      if (own !== generation || destroyed || scope !== installation()) return;
      if (!Number.isSafeInteger(base.s.revision) ||
          base.s.assignmentContractVersion === 2 && !Number.isSafeInteger(base.s.policyRevision))
        throw new Error("Gateway returned invalid management revisions.");
      state = base.s;
      workspaces = base.w;
      agents = base.a;
      rememberBase(scope,workspaces,agents);
      authority = { generation: own, installation: scope };
      body.replaceChildren();
      localTables.clear();
      updateTabs();
      if (tab === "Workspaces") {
        if (state.assignmentContractVersion===2) await renderDevelopmentWorkspaces(own);
        else await renderWorkspaces(own);
      }
      if (tab === "Agents") await renderAgents(own);
      if (tab === "Activity") await renderActivity(own);
      if (tab === "Recovery") await renderRecovery(own);
      if (tab === "Settings") {
        renderSettings();
        if (num(state.libraryRevision)>0 && client.exportResources)
          body.append(button('Export legacy Resource archive',async()=>{
            const bytes=await client.exportResources!();
            client.download('perch-resource-archive.zip',bytes,'application/zip');
          }));
      }
      if (own === generation) {
        refreshRemoteButtons();
        announce("Updated.");
      }
    } catch (e) {
      if (own !== generation) return;
      authority = undefined;
      dismissConfirmation();
      renderViewShell("Gateway unavailable. Remote actions require a fresh connection.");
      report(e);
    }
  }
  function updateTabs() {
    body.setAttribute("role", "tabpanel");
    body.setAttribute("aria-label", tabLabel());
    for (const [name, b] of buttons) {
      b.setAttribute("aria-selected", String(name === tab));
      if (name==='Agents') b.textContent='Connectors';
    }
  }
  function permissionEditor(parent: HTMLElement, values: readonly string[], allowed: readonly string[] = PERMISSIONS) {
    const box = el("div", undefined, "permissions");
    const checks = new Map<string, HTMLInputElement>();
    for (const permission of allowed) {
      const l = el("label"),
        cb = el("input");
      cb.type = "checkbox";
      cb.checked = values.includes(permission);
      l.append(cb, doc.createTextNode(permission));
      box.append(l);
      checks.set(permission, cb);
    }
    parent.append(box);
    return () =>
      [...checks]
        .filter(([, cb]) => cb.checked)
        .map(([permission]) => permission);
  }
  /** One explicit connection action; remote pause changes use readback and are
   * never replayed after a lost acknowledgement. */
  async function connectWorkspace(w: Row): Promise<void> {
    const own = generation;
    requireAuthority(own);
    const id=str(w.id);
    if(!id)throw new Error('Choose a Workspace first.');
    const current=record(await client.request('GET',`${ADMIN}/workspaces/${encodeURIComponent(id)}`));
    if(str(current.id)!==id)throw new Error('Workspace changed; refresh the list.');
    requireAuthority(own);
    if(state.paused===true){
      // The button explicitly says that all Workspaces will be resumed.
      try{await client.request('POST',`${ADMIN}/pause`,{
        expectedRevision:num(state.policyRevision),paused:false,
      });}catch(error){
        const actual=record(await client.request('GET',`${ADMIN}/state`));
        if(actual.paused===true)throw error;
      }
    }
    let ready=current;
    if(current.paused===true){
      requireAuthority(own);
      try{await client.request('PATCH',`${ADMIN}/workspaces/${encodeURIComponent(id)}`,{
        expectedRevision:num(current.revision),paused:false,
      });}catch(error){
        const actual=record(await client.request('GET',`${ADMIN}/workspaces/${encodeURIComponent(id)}`));
        if(actual.paused===true)throw error;
      }
      ready=record(await client.request('GET',`${ADMIN}/workspaces/${encodeURIComponent(id)}`));
      if(ready.paused!==false)throw new Error('Workspace is still paused. Refresh its status.');
    }
    try {
      if(!client.attach)throw new Error('The native browser connection is unavailable.');
      requireAuthority(own);
      await client.attach(ready);
      await refresh();
      announce('Editor connected. The agent can continue.');
    }catch(error){
      const code=error&&typeof error==='object'&&'code'in error
        ?String((error as {code:unknown}).code):'';
      if(code==='EFFECT_UNKNOWN'||code==='TAB_BUSY'){
        recoveryWorkspaceId=id;
        tab='Recovery';updateTabs();await refresh();
        announce(`Connection held (${code}). Recovery shows the next action.`,true);
        return;
      }
      throw error;
    }
  }
  async function bindEditorWorkspace(w:Row,replace:boolean):Promise<void>{
    const probed=client.probe?record(await client.probe()):null;
    if(probed&&(probed.ready!==true||!probed.identity))
      throw new Error('This editor is not ready. Open its Edit view and try again.');
    const identity=await client.currentIdentity();
    const configured=client.configuration();
    const binding={...identity,browserInstallationId:
      identity.browserInstallationId??configured.browserInstallationId};
    if(!binding.browserInstallationId)
      throw new Error('Browser installation identity is unavailable. Inspect pairing in Settings.');
    const id=str(w.id),live=record(await client.request('GET',`${ADMIN}/workspaces/${encodeURIComponent(id)}`));
    if(live.id!==id)throw new Error('Workspace was changed or removed. Refresh.');
    const result=record(await client.request('POST',
      `${ADMIN}/workspaces/${encodeURIComponent(id)}/bind`,
      {expectedRevision:num(live.revision),binding,replace}));
    await connectWorkspace({...live,...result});
  }
  async function transitionWorkspace(w: Row, action: string, args: Row, own: number) {
    requireAuthority(own);
    const id = str(w.id);
    if (mutationPending.has(id)) throw new Error('A change is pending for this Workspace.');
    const path = `${ADMIN}/workspaces/${encodeURIComponent(id)}/${action}`;
    const current = agents.items.find(item=>item.id===w.connectorId);
    const cached = v2Requests.get(id);
    if (cached && cached.action!==action) throw new Error('Inspect the original Workspace transition first.');
    const request = cached ?? {workspaceId:id,action,key:crypto.randomUUID()};
    const scope = installation();
    const retire = async () => {
      if (installation() !== scope) return;
      await client.transitionReceipts?.retire(request.key);
      v2Requests.delete(id);
    };
    v2Requests.set(id,request);
    mutationPending.add(id);
    try {
      let next: Row;
      const reconcile = async () => {
        const receipt=record(await client.request('GET',`${ADMIN}/receipts/${request.key}`));
        const result=record(receipt.result);
        if (result.id!==id)
          throw new Error('Receipt did not identify the requested Workspace.');
        return result;
      };
      if (!cached) {
        try {
          await client.transitionReceipts?.retain(request);
          requireAuthority(own);
        } catch (error) {
          await retire();
          throw error;
        }
      }
      try {
        if (cached) {
          next = await reconcile();
        } else {
          next=record(await client.request('POST',path,{
            expectedRevision:w.revision,...(current ? {expectedConnectorRevision:current.revision} : {}),...args,
          },{idempotencyKey:request.key}));
          if (next.id !== id) throw new Error("Response did not identify the requested Workspace.");
        }
      } catch (error) {
        if (cached) throw new Error('The original Workspace transition is unresolved. Inspect its receipt before making a new change.');
        const code = error && typeof error==='object' && 'code' in error ? String(error.code) : '';
        if (['STALE_REVISION','APPROVAL_REQUIRED','SCOPE_DENIED','BINDING_MISMATCH','TAB_BUSY','INVALID_INPUT','CONFLICT'].includes(code)) {
          await retire();
          throw error;
        }
        try {
          next=await reconcile();
        } catch {
          throw new Error('Transition outcome is unknown. Inspect the original Workspace receipt.');
        }
      }
      await retire();
      if (!cached && action==='rebind' && next.binding && client.attach && own===generation) {
        try { requireAuthority(own); await client.attach(next); }
        catch { if (own===generation) announce('Binding committed. Reconnect this verified editor to acquire its lease.',true); return; }
      }
      if (own===generation) await refresh();
    } finally { mutationPending.delete(id); }
  }
  async function renderDevelopmentWorkspaces(own: number) {
    heading('Workspaces');
    const creation=el("details",undefined,"workspace-create");
    creation.append(el("summary","Create Workspace"));
    const create = field('Workspace name');
    actions(creation,create.label,remoteButton('Create Workspace',own,async()=>{
      if (!create.input.value.trim()) throw new Error('Enter a Workspace name.');
      await client.request('POST',`${ADMIN}/workspaces`,{contractVersion:2,label:create.input.value.trim()});
      if (own===generation) await refresh();
    }));
    body.append(creation);
    const scope = installation();
    const [nextIdentity, pending] = await Promise.all([
      client.currentIdentity().catch(()=>undefined),
      client.transitionReceipts?.list() ?? [],
    ]);
    if (own!==generation || destroyed || scope!==installation()) return;
    if (receiptInstallation !== scope) {
      receiptInstallation = scope;
      v2Requests.clear();
    }
    for (const receipt of pending) v2Requests.set(receipt.workspaceId, receipt);
    const choices = agents.items.filter(item=>item.contractVersion===2 && item.suspended!==true);
    p(nextIdentity ? `Current editor: ${nextIdentity.slug} · ${nextIdentity.generatorId} · draft ${nextIdentity.draftId || "(default)"}` : "Current editor identity unavailable.",body,"muted");
    search();
    table([
      {key:'label',label:'Workspace',render(w,td){
        td.append(el('strong',str(w.label)));
        const connector=agents.items.find(item=>item.id===w.connectorId || item.workspaceId===w.id);
        p(connector ? str(connector.label) : 'Unassigned',td,'muted');
      }},
      {key:'binding',label:'Binding and status',render(w,td){
        const previous=record(w.binding);
        const observation=record(w.observation);
        const now=Date.now();
        const seenAt=num(observation.observedAt);
        const fresh=!!w.binding && observation.epoch===w.epoch &&
          Number.isSafeInteger(seenAt) && seenAt<=now+60000 && seenAt+60000>now;
        p(w.binding ? `${str(previous.slug)} · ${str(previous.generatorId)} · draft ${str(previous.draftId)||'(default)'}` : 'Unbound',td);
        const connection=!w.binding?'No active Binding':w.paused?'Paused':fresh?'Heartbeat recent':'Offline';
        const source=fresh?observation.dirty===true?'Unsaved':
          observation.dirty===false?'Draft clean':'Dirty unknown':'Dirty unknown';
        p(connection+' · '+source,td,'muted');
        if (w.transition) p('Transition awaiting settlement',td,'muted');
      }},
      {key:'action',label:'Actions',render(w,td){
        if (w.contractVersion!==2) {
          td.append(button('Reconnect legacy Workspace',async()=>connectWorkspace(w)));
          return;
        }
        const intent: Row = {...w, binding: w.binding ? {...record(w.binding)} : w.binding,
          transition: w.transition ? {...record(w.transition)} : w.transition};
        const id=str(intent.id),wd=intent.binding!==null && intent.binding!==undefined;
        const pending = v2Requests.get(id);
        if (pending) {
          p(`Transition outcome unknown · ${pending.key}`, td, "muted");
          td.append(remoteButton("Inspect original transition", own, () =>
            transitionWorkspace(intent, pending.action, {}, own)));
          return;
        }
        const previous = record(intent.binding);
        const owningConnector = agents.items.find(item => item.id === intent.connectorId);
        const scope = `${str(intent.label, id)} (${id}) · ${str(owningConnector?.label, 'Unassigned')}`;
        const oldDraft = `${str(previous.generatorId, 'Unbound')} · draft ${str(previous.draftId) || '(default)'}`;
        const observation=record(w.observation);
        const dirty=wd && !(observation.epoch===w.epoch && observation.dirty===false &&
          num(observation.observedAt)+60000>Date.now());
        if (nextIdentity && client.bindingProof) {
          const destination = {...nextIdentity};
          td.append(markRemote(button(wd?'Reassign to this tab':'Assign this tab',async()=>{
            const rebind=async()=>{
              const cached=v2Requests.get(id);
              if (cached) return transitionWorkspace(intent,'rebind',{},own);
              const exact=await client.currentIdentity();
              if (exact.generatorId !== destination.generatorId || exact.slug !== destination.slug ||
                  exact.draftId !== destination.draftId || exact.browserInstallationId !== destination.browserInstallationId)
                throw new Error('This editor changed after the actions were shown. Refresh Workspaces.');
              requireAuthority(own);
              const probe=client.probe ? record(await client.probe()) : null;
              if (probe && probe.ready!==true) throw new Error('This editor is not ready.');
              const latest = await client.currentIdentity();
              if (latest.generatorId !== destination.generatorId || latest.draftId !== destination.draftId ||
                  latest.browserInstallationId !== destination.browserInstallationId)
                throw new Error('This editor changed during confirmation. Refresh Workspaces.');
              requireAuthority(own);
              const proof=record(await client.bindingProof!(intent,destination));
              await transitionWorkspace(intent,'rebind',{binding:destination,bindingProof:proof.proof,acknowledgeDirty:dirty},own);
            };
            if (dirty && !v2Requests.has(id))
              confirmAction(`Reassign ${scope} from ${oldDraft} to ${destination.generatorId} · draft ${destination.draftId || '(default)'}? The previous draft will remain in place.`,rebind,true);
            else await runRemoteAction(own, rebind);
          })));
        }
        const secondary=el("details",undefined,"secondary-actions");
        secondary.append(el("summary","More actions"));
        td.append(secondary);
        if (wd) {
          secondary.append(remoteButton('Reconnect',own,async()=>connectWorkspace(intent)),
            markRemote(button('Detach',()=>confirmAction(`Detach ${scope} from ${oldDraft} and preserve the native draft?`,async()=>
              transitionWorkspace(intent,'detach',{acknowledgeDirty:true},own),true))));
        }
        secondary.append(remoteButton(intent.paused?'Resume':'Pause',own,async()=>{
          await client.request('PATCH',`${ADMIN}/workspaces/${encodeURIComponent(id)}`,
            {expectedRevision:intent.revision,paused:!intent.paused});
          if (own===generation) await refresh();
        }));
        const policies=el('details');
        policies.append(el('summary','Permissions'));
        const values=permissionEditor(policies,Array.isArray(w.permissions)?w.permissions as string[]:[],v2Permissions);
        policies.append(remoteButton('Save Workspace permissions',own,async()=>{
          await client.request('PATCH',`${ADMIN}/workspaces/${encodeURIComponent(id)}`,{
            expectedRevision:intent.revision,permissions:values(),
          });
          if (own===generation) await refresh();
        }));
        secondary.append(policies);
        const other=choices.filter(item=>item.id!==w.connectorId);
        if (other.length) {
          const chosen=select('Destination Connector',other.map(item=>({value:str(item.id),label:str(item.label)})));
          secondary.append(chosen.label,markRemote(button(intent.connectorId?'Transfer':'Assign Connector',async()=>{
            const selected=other.find(item=>item.id===chosen.input.value);
            if (!selected) throw new Error('Choose a Connector.');
            const args={connectorId:selected.id,expectedDestinationConnectorRevision:selected.revision,acknowledgeDirty:dirty};
            if (intent.connectorId) confirmAction(`Transfer ${scope} to ${str(selected.label, str(selected.id))} and preserve ${oldDraft}?`,async()=>
              transitionWorkspace(intent,'transfer',args,own),true);
            else if (dirty) confirmAction(`Assign ${scope} to ${str(selected.label, str(selected.id))} and preserve ${oldDraft}?`,async()=>transitionWorkspace(intent,'assign',args,own),true);
            else await runRemoteAction(own, () => transitionWorkspace(intent,'assign',args,own));
          })));
        }
        if (intent.connectorId) secondary.append(markRemote(button('Unassign',()=>confirmAction(`Unassign ${scope} and preserve ${oldDraft}?`,async()=>
          transitionWorkspace(intent,'unassign',{acknowledgeDirty:true},own),true))));
        if (intent.transition && !mutationPending.has(id)) secondary.append(markRemote(button('Cancel pending transition',()=>
          confirmAction(`Cancel the pending transition for ${scope} after pending effects settle?`,async()=>{
            await client.request('POST',`${ADMIN}/workspaces/${encodeURIComponent(id)}/abort-transition`,
              {expectedRevision:intent.revision,transitionId:record(intent.transition).id},{idempotencyKey:crypto.randomUUID()});
            v2Requests.delete(id);
            if (own===generation) await refresh();
          },true))));
      }},
    ],workspaces.items);
    body.querySelectorAll("table").forEach(t=>t.classList.add("compact-workspaces"));
  }
  async function renderWorkspaces(own:number) {
    heading("Workspaces");
    p(`Connection: ${status.connection}${status.reason ? ` · ${status.reason}` : ""}`,body,'muted');
    let detectedIdentity:ManagerIdentity|undefined;
    const quick=el('section',undefined,'recovery-status');
    quick.append(el('strong',status.connection==='connected'?'Editor connected':'Connect the current editor'));
    if(status.connection==='connected'){
      p('This tab has a verified lease. Leave it open for the agent.',quick,'muted');
    }else{
      let native:ManagerIdentity|undefined;
      try {
        const probe=client.probe?record(await client.probe()):null;
        if(probe && (probe.ready!==true || !probe.identity))
          throw new Error('Native editor is not ready.');
        native=await client.currentIdentity();
      }catch{
        p('Open the generator in Edit mode, then select Retry editor detection. Pairing and Gateway are independent of editor readiness.',quick);
        quick.append(button('Retry editor detection',async()=>refresh(),'primary'));
      }
      if(native){
        detectedIdentity=native;
        const matches=(w:Row)=>{
          const b=record(w.binding);
          return b.generatorId===native!.generatorId&&b.draftId===native!.draftId&&
            b.slug===native!.slug;
        };
        const exact=workspaces.items.filter(w=>matches(w)&&
          record(w.binding).browserInstallationId===native!.browserInstallationId);
        const sameGenerator=workspaces.items.filter(w=>{
          const b=record(w.binding);
          return b.generatorId===native!.generatorId&&b.draftId===native!.draftId;
        });
        const unused=workspaces.items.filter(w=>!w.binding);
        if(exact.length===1){
          const w=exact[0]!;
          p(`Matched Workspace: ${str(w.label)}. The current editor will be verified again before claiming a lease.`,quick,'muted');
          if(state.paused===true)
            p('Gateway-wide execution is paused; connecting will resume all Workspaces.',quick,'muted');
          else if(w.paused===true)
            p('This Workspace is paused; connecting will resume it.',quick,'muted');
          quick.append(button(state.paused===true?'Resume all Workspaces and connect':
            w.paused===true?'Resume Workspace and connect':'Connect this editor',
            async()=>connectWorkspace(w),'primary'));
        }else if(exact.length>1){
          p('Several Workspaces match this editor. Choose the intended Workspace in the list below.',quick);
        }else if(sameGenerator.length===1){
          const w=sameGenerator[0]!;
          p(`The editor matches ${str(w.label)} but its saved browser installation differs. Rebinding revokes the old connector Grants; authorize the agent again afterward.`,quick);
          quick.append(button('Rebind this editor',async()=>bindEditorWorkspace(w,true),'primary'));
        }else if(sameGenerator.length>1){
          p('Multiple Workspaces refer to this generator. Choose one explicitly below; no automatic takeover.',quick);
        }else if(unused.length===1){
          const w=unused[0]!;
          p(`One unbound Workspace is available: ${str(w.label)}. Link it to this editor to begin.`,quick,'muted');
          quick.append(button('Link Workspace and connect',async()=>bindEditorWorkspace(w,false),'primary'));
        }else{
          p('No Workspace is linked to this generator. Link an unbound Workspace, or choose Workspace settings → Rebind current editor to replace an existing binding.',quick,'muted');
        }
      }
    }
    if(own!==generation)return;
    body.append(quick);
    const form = el("form"),
      row = el("div", undefined, "row"),
      name = field("Workspace name"),
      preset = select("Permissions", [
        { value: "default", label: "Source + preview controls" },
        {
          value: "development",
          label: "Development: also preview execution + Save",
        },
      ]);
    name.input.required = true;
    name.input.maxLength = 80;
    const create = button("Create Workspace", async () => {
      if (!form.reportValidity()) return;
      const permissions =
        preset.input.value === "development"
          ? [...DEFAULT_PERMISSIONS, "PREVIEW_EXECUTE", "SAVE"]
          : DEFAULT_PERMISSIONS;
      await client.request("POST", `${ADMIN}/workspaces`, {
        label: name.input.value.trim(),
        permissions,
      });
      name.input.value = "";
      await refresh();
    });
    row.append(name.label, preset.label, create);
    form.append(row);
    on(form, "submit", (e) => {
      e.preventDefault();
      activateButton(create);
    });
    const createSection=el('details');
    createSection.className='workspace-create';
    createSection.append(el('summary','Create another Workspace'),form);
    body.append(createSection);
    if(status.connection==='blocked'){
      p('The current Workspace cannot claim a lease. Recovery identifies the exact active lease or uncertain operation without clearing evidence.',body);
      body.append(button('Open Recovery',async()=>{
        if(status.workspace)recoveryWorkspaceId=status.workspace;
        tab='Recovery';updateTabs();await refresh();
      }));
    }
    search();
    table(
      [
        {
          key: "label",
          label: "Workspace",
          render(w, td) {
            td.append(el("strong", str(w.label)));
            p(str(w.id), td, "muted");
          },
        },
        {
          key: "binding",
          label: "Binding / connection",
          render(w, td) {
            const b = record(w.binding),
              recovered = record(record(w.recoveryBinding).binding);
            if (!w.binding && recovered.generatorId)
              p(
                `Recovery target: ${str(recovered.slug)} · ID ${str(recovered.generatorId)} · draft ${str(recovered.draftId) || "(default)"}; inspect held operations before rebinding.`,
                td,
              );
            p(
              w.binding
                ? `${str(b.slug)} · ID ${str(b.generatorId)} · draft ${str(b.draftId) || "(default)"}`
                : "Unbound",
              td,
            );
            p(
              [
                w.paused ? "Paused" : str(w.state, "Active"),
                w.lastHeartbeat ? `Heartbeat ${str(w.lastHeartbeat)}` : "",
                w.inFlightOperation
                  ? `Operation ${str(w.inFlightOperation)}`
                  : "",
                w.currentRevision ? `Revision ${str(w.currentRevision)}` : "",
              ]
                .filter(Boolean)
                .join(" · "),
              td,
              "muted",
            );
            const a = agents.items.find((a) => a.workspaceId === w.id);
            if (a)
              td.append(
                copy(
                  "Copy connector URL",
                  endpoint(client.configuration().origin, a),
                ),
              );
          },
        },
        {
          key: "revision",
          label: "Actions",
          render(w, td) {
            const bind=(replace:boolean)=>bindEditorWorkspace(w,replace);
            actions(
              td,
              ...(w.binding?[]:[button(
                "Attach current editor",
                async () => {
                  if (w.binding)
                    confirmAction(
                      "Replace this Binding with the current editor? Previous Grants will be revoked. Any uncertain operation remains held.",
                      () => bind(true),
                    );
                  else await bind(false);
                },
              )]),
              button(w.paused ? "Resume" : "Pause", async () => {
                await client.request(
                  "PATCH",
                  `${ADMIN}/workspaces/${encodeURIComponent(str(w.id))}`,
                  { expectedRevision: num(w.revision), paused: !w.paused },
                );
                await refresh();
              }),
              ...(w.binding?[button(w.paused?'Resume & connect':'Reconnect',async()=>connectWorkspace(w))]:[]),
              ...(w.binding && detectedIdentity &&
                  record(w.binding).generatorId===detectedIdentity.generatorId &&
                  record(w.binding).draftId===detectedIdentity.draftId && (
                  record(w.binding).slug!==detectedIdentity.slug ||
                  record(w.binding).browserInstallationId!==detectedIdentity.browserInstallationId
                )?[button('Replace binding…',async()=>{
                  confirmAction('Replace this Workspace binding with the current editor? Existing connector Grants will be revoked. No source will be overwritten.',()=>bind(true));
                })]:[]),
              ...(status.connection==='blocked' && status.workspace===w.id ? [button('Fix connection',async()=>{
                recoveryWorkspaceId=str(w.id);
                tab='Recovery';updateTabs();await refresh();
              })] : []),
            );
            const details = el("details"),
              summary = el("summary", "Workspace settings");
            details.append(summary);
            details.append(button(
                "Detach",
                async () => {
                  confirmAction(
                    "Detach this Workspace and revoke its Grants? Dispatched effects still require reconciliation.",
                    async () => {
                      await client.request(
                        "POST",
                        `${ADMIN}/workspaces/${encodeURIComponent(str(w.id))}/detach`,
                        { expectedRevision: num(w.revision) },
                      );
                      await refresh();
                    },
                  );
                },
                "danger",
              ));
            if(w.binding)details.append(button("Rebind current editor",async()=>{
              confirmAction("Replace this binding and revoke previous Grants?",()=>bind(true));
            }));
            const label = field("Workspace label", str(w.label));
            details.append(label.label);
            const selected = permissionEditor(
              details,
              arrayStrings(w.permissions),
            );
            details.append(
              button("Apply Workspace changes", async () => {
                await client.request(
                  "PATCH",
                  `${ADMIN}/workspaces/${encodeURIComponent(str(w.id))}`,
                  {
                    expectedRevision: num(w.revision),
                    label: label.input.value.trim(),
                    permissions: selected(),
                  },
                );
                await refresh();
              }),
            );
            p(
              "Enabling external effects authorizes their capability. Listing, delete and production restore still need an operation-bound approval.",
              details,
              "muted",
            );
            td.append(details);
          },
        },
      ],
      workspaces.items,
    );
  }
  async function renderAgents(own: number) {
    const v2=state.assignmentContractVersion===2;
    heading("Connectors and OAuth");
    p(
      v2 ? "A Connector can reach multiple assigned Workspaces. Chats using the same Connector share its Grant." :
        "Legacy Connector: fixed Workspace scope. Fresh installations use Connector-level authorization.",
      body,
      "muted",
    );
    if (status.connection !== "connected")
      p(
        "Editor connection: " + status.connection +
          ". The gateway can approve OAuth while this tab is offline, but MCP tools will not run. " +
          "Open Workspaces and explicitly reconnect the matching native editor after checking for pending operations.",
        body,
        "muted",
      );
    const row = el("div", undefined, "row"),
      name = field("Connector name"),
      target = select(
        "Workspace",
        workspaces.items
          .filter((w) => !w.agentId)
          .map((w) => ({ value: str(w.id), label: str(w.label) })),
      );
    name.input.maxLength = 80;
    const ceilingPanel=el('details');
    ceilingPanel.append(el('summary','Permission ceiling'));
    const newCeiling=permissionEditor(ceilingPanel,v2DefaultPermissions,v2Permissions);
    row.append(
      name.label,
      ...(v2 ? [ceilingPanel] : [target.label]),
      remoteButton(v2?"Create Connector":"Create Agent", own, async () => {
        if (!name.input.value.trim() || !v2 && !target.input.value)
          throw new Error(v2?"Enter a Connector name.":"Enter a name and select an unassigned Workspace.");
        await client.request("POST", `${ADMIN}/${v2?'connectors':'agents'}`, {
          label: name.input.value.trim(),
          ...(v2 ? {expectedRevision:state.revision,permissionCeiling:newCeiling()} : {workspaceId:target.input.value}),
        });
        await refresh();
      }),
    );
    body.append(row);
    // Time-limited consent must appear before the potentially long Connector list.
    const approvalPanel = el("section");
    const grantsPanel = el("section");
    body.append(approvalPanel);
    search();
    table(
      [
        {
          key: "label",
          label: "Connector",
          render(a, td) {
            p(str(a.label), td);
            p(str(a.id), td, "muted");
            if (a.contractVersion===2) {
              const settings=el('details');
              settings.append(el('summary','Permission ceiling'));
              const permissions=permissionEditor(settings,Array.isArray(a.permissionCeiling)?a.permissionCeiling as string[]:[],v2Permissions);
              settings.append(remoteButton('Save Connector ceiling',own,async()=>{
                await client.request('PATCH',`${ADMIN}/connectors/${encodeURIComponent(str(a.id))}`,{
                  expectedRevision:a.revision,permissionCeiling:permissions(),
                });
                if (own===generation) await refresh();
              }));
              td.append(settings);
            }
            const legacyWorkspace=workspaces.items.find(w=>w.id===a.workspaceId);
            if (v2 && a.contractVersion===1 && legacyWorkspace?.binding)
              td.append(markRemote(button('Upgrade to v2',()=>confirmAction(
                `Upgrade Connector ${str(a.label, str(a.id))} on Workspace ${str(legacyWorkspace.label, str(legacyWorkspace.id))}? Fresh consent is required for ${str(a.endpoint)}.`,async()=>{
                await client.request('POST',`${ADMIN}/connectors/${encodeURIComponent(str(a.id))}/upgrade`,{
                  expectedRevision:a.revision,expectedWorkspaceRevision:legacyWorkspace.revision,acknowledgeReauthorization:true,
                },{idempotencyKey:crypto.randomUUID()});
                if (own===generation) await refresh();
              },true))));
          },
        },
        {
          key: "workspaceId",
          label: "Access",
          render(a, td) {
            const url = endpoint(client.configuration().origin, a);
            const first = el("div", undefined, "compact-connector");
            first.append(copy("Copy URL", url));
            p(a.contractVersion===2 ? `${num(a.assignmentCount)} Workspaces · ${a.suspended?"suspended":"enabled"}` :
              `Legacy Workspace: ${str(workspaces.items.find(w=>w.id===a.workspaceId)?.label,str(a.workspaceId))}`, first, "muted");
            const setup=el("details",undefined,"secondary-actions");
            setup.append(el("summary","Connector URL and setup"));
            const input=field("MCP connector URL",url);
            input.input.readOnly=true;
            setup.append(input.label,copy("Copy setup instructions",
              `Create a custom remote MCP connector with URL ${url}. Complete OAuth, approve the exact request in Perch MCP → Connectors, then call workspace_status. Tokens remain in the client.`));
            td.append(first,setup);
          },
        },
        {
          key: "suspended",
          label: "Actions",
          render(a, td) {
            const settings=el("details",undefined,"secondary-actions");
            settings.append(el("summary","Manage Connector"));
            td.append(settings);
            const label = field("Connector label", str(a.label));
            settings.append(label.label);
            actions(
              settings,
              remoteButton("Rename", own, async () => {
                await client.request(
                  "PATCH",
                  `${ADMIN}/${a.contractVersion===2?'connectors':'agents'}/${encodeURIComponent(str(a.id))}`,
                  {
                    expectedRevision: num(a.revision),
                    label: label.input.value.trim(),
                  },
                );
                await refresh();
              }),
              remoteButton(
                a.suspended ? "Resume Connector" : "Suspend Connector",
                own,
                async () => {
                  await client.request(
                    "PATCH",
                    `${ADMIN}/${a.contractVersion===2?'connectors':'agents'}/${encodeURIComponent(str(a.id))}`,
                    {
                      expectedRevision: num(a.revision),
                      suspended: !a.suspended,
                    },
                  );
                  await refresh();
                },
              ),
            );
          },
        },
      ],
      agents.items,
    );
    // The time-limited OAuth request must be visible without waiting for
    // unrelated Grant data. A failure in either list does not hide the other.
    body.append(grantsPanel);
    let lastApprovalState = "";
    let pendingApprovalCount = 0;
    const loadApprovals = async () => {
      const approvals = await loadList(`${ADMIN}/approvals`);
      if (own !== generation || destroyed || !opened || tab !== "Agents")
        return;
      const pending = approvals.items.filter(
        (item) => item.state === "pending" && num(item.expiresAt) > Date.now(),
      );
      pendingApprovalCount = pending.length;
      const fingerprint = JSON.stringify(pending);
      if (fingerprint === lastApprovalState) return; // Preserve focus while polling.
      lastApprovalState = fingerprint;
      approvalPanel.replaceChildren();
      heading("Pending approvals", approvalPanel);
      p(
        "Verify the code, Connector, audience, client, callback and application permissions before approving.",
        approvalPanel,
        "muted",
      );
      table(
        [
          {
            key: "code",
            label: "Request",
            render(a, td) {
              const connector = agents.items.find(item => item.id === a.agentId);
              p(`${str(a.kind)} · ${str(a.code)}`, td);
              p(`Connector ${str(connector?.label, str(a.agentId, "Unknown"))} · ${str(a.agentId)}`, td);
              if (a.workspaceId) p(`Workspace ${str(a.workspaceId)}`, td);
              p(
                `Client ${str(a.clientId, "Unknown")} · expires ${new Date(num(a.expiresAt)).toLocaleString()}`,
                td,
                "muted",
              );
            },
          },
          {
            key: "digest",
            label: "Exact authorization",
            render(a, td) {
              if (a.kind === "oauth") {
                p(`Audience: ${str(a.audience, "Unavailable")}`, td);
                p(`Application permission ceiling: ${Array.isArray(a.permissionSnapshot)
                  ? arrayStrings(a.permissionSnapshot).join(", ") || "None" : "Unavailable"}`, td);
              }
              p(`Redirect: ${str(a.redirectUri)}`, td);
              p(
                `OAuth scopes: ${Array.isArray(a.scope) ? arrayStrings(a.scope).join(", ") : str(a.scope)}`,
                td,
              );
              p(`Digest: ${str(a.digest)}`, td);
              if (a.tool)
                p(`Operation ${str(a.operationId)} · ${str(a.tool)}`, td);
            },
          },
          {
            key: "state",
            label: "Decision",
            render(a, td) {
              p(str(a.state), td);
              const connector = agents.items.find(item => item.id === a.agentId);
              const requiresExact = a.kind === "oauth" && v2;
              const valid = !requiresExact || (
                !!connector && connector.contractVersion === 2 &&
                typeof a.audience === "string" && !!a.audience &&
                a.audience === connector.endpoint && !!str(a.clientId) && !!str(a.redirectUri) &&
                !!str(a.code) && Array.isArray(a.permissionSnapshot) &&
                a.permissionSnapshot.every(permission => v2Permissions.some(accepted => accepted === permission)) &&
                Number.isSafeInteger(a.revision) && /^[a-f0-9]{64}$/.test(str(a.digest))
              );
              if (!valid) p("Approval blocked because the exact authorization details could not be verified.", td);
              const approval = {
                id: str(a.id), expectedRevision: num(a.revision) || approvals.revision,
                digest: str(a.digest), expiresAt: num(a.expiresAt),
              };
              actions(
                td,
                markRemote(button("Approve exact request", () => runRemoteAction(own, async () => {
                  if (!valid || approval.expiresAt <= Date.now()) throw new Error("Authorization request expired or changed.");
                  await client.request(
                    "POST",
                    `${ADMIN}/approvals/${encodeURIComponent(approval.id)}/decision`,
                    {
                      expectedRevision: approval.expectedRevision,
                      digest: approval.digest,
                      decision: "approve",
                    },
                  );
                  await refresh();
                })), !valid),
                remoteButton(
                  "Deny",
                  own,
                  async () => {
                    if (approval.expiresAt <= Date.now()) throw new Error("Authorization request expired.");
                    await client.request(
                      "POST",
                      `${ADMIN}/approvals/${encodeURIComponent(approval.id)}/decision`,
                      {
                        expectedRevision: approval.expectedRevision,
                        digest: approval.digest,
                        decision: "deny",
                      },
                    );
                    await refresh();
                  },
                  "danger",
                ),
              );
            },
          },
        ],
        pending,
        approvalPanel,
        false,
      );
    };
    const approvalToolbar=el("div",undefined,"row");
    approvalToolbar.append(button("Check pending approvals", async()=>loadApprovals()));
    p("Automatic checks stop after 30 seconds without pending requests. Use this button when starting a new authorization.",approvalToolbar,"muted");
    approvalPanel.before(approvalToolbar);
    const showApprovalsFailure = (error: unknown) => {
      if (own !== generation || !opened || destroyed || tab !== "Agents") return;
      authority=undefined;
      dismissConfirmation();
      refreshRemoteButtons();
      if (!approvalPanel.textContent?.includes("Pending approvals")) {
        approvalPanel.replaceChildren();
        heading("Pending approvals", approvalPanel);
        p("Could not retrieve approvals. Check approvals manually or retry after service recovery.", approvalPanel);
      }
      announce(errorText(error), true);
    };
    // Never overlap requests: a stalled gateway must not pile up polling
    // calls, reorder snapshots or amplify its own outage.
    let approvalFailures = 0;
    let quotaDelay=0;
    const approvalWatchStarted = Date.now();
    const pollApprovals = async () => {
      if (own !== generation || destroyed || !opened || tab !== "Agents") return;
      approvalRefreshTimer = undefined;
      if (doc.visibilityState === "hidden") return;
      try {
        await loadApprovals();
        // A failed poll invalidates prior mutation authority. Reacquire through explicit Refresh, not by assuming this list repairs all revisions.
        approvalFailures = 0;
        quotaDelay=0;
      } catch (error) {
        approvalFailures++;
        quotaDelay=typeof error==="object"&&error!==null&&"connectivityRetryAfterSeconds" in error&&error.connectivityRetryAfterSeconds===300 ? 300000 : 0;
        showApprovalsFailure(error);
      }
      // Check generation after the await: a closed or superseded manager must
      // never restart the timer. Only one automatic request is in flight.
      if (own !== generation || destroyed || !opened || tab !== "Agents" || isDocumentHidden()) return;
      const delay=approvalPollingDelay(pendingApprovalCount,Date.now()-approvalWatchStarted,
        approvalFailures,quotaDelay);
      if(delay===null) return; // idle or repeatedly failing; explicit refresh is always available.
      approvalRefreshTimer = setTimeout(() => void pollApprovals(), delay);
      (approvalRefreshTimer as unknown as { unref?: () => void }).unref?.();
    };
    await pollApprovals();
    if (own !== generation || destroyed || !opened || tab !== "Agents") return;
    void (async () => {
      try {
        const grants = await loadList(`${ADMIN}/grants`);
        if (own !== generation || destroyed || !opened || tab !== "Agents") return;
        grantsPanel.replaceChildren();
        heading("Grants", grantsPanel);
        table(
          [
            {
              key: "agentId",
              label: "Connector / Workspace",
              render(g, td) {
                const connector=agents.items.find(a=>a.id===g.agentId);
                p(`${str(connector?.label,str(g.agentId))}${g.workspaceId ? " / "+str(g.workspaceId) : ""}`,td);
                p(str(g.clientId), td, "muted");
              },
            },
            {
              key: "state",
              label: "Authorization",
              render(g, td) {
                const connector=agents.items.find(a=>a.id===g.agentId);
                p(g.state==="revoked"?"Revoked":g.expiresAt===null && g.contractVersion===2
                  ? connector?.suspended===true ? "Suspended (authorization retained)" : "Authorized — until revoked"
                  : num(g.expiresAt)>Date.now()?"Authorized (legacy finite Grant)":"Credentials unavailable / recovery required",td);
                if (g.audience) p(`Audience: ${str(g.audience)}`,td,"muted");
                if (Array.isArray(g.permissions)) p(`Grant permissions: ${arrayStrings(g.permissions).join(", ") || "None"}`,td,"muted");
              },
            },
            {
              key: "id",
              label: "Actions",
              render(g, td) {
                if (g.state === "revoked") {
                  p("Revoked — no further authorization", td, "muted");
                  return;
                }
                const grant = { id: str(g.id), revision: num(g.revision),
                  clientId: str(g.clientId), connectorId: str(g.agentId) };
                const connector = agents.items.find(item => item.id === grant.connectorId);
                const revoke = markRemote(button("Revoke Grant", () => {
                  confirmAction(
                    `Revoke Grant ${grant.id} for ${grant.clientId} on Connector ${str(connector?.label, grant.connectorId)}?`,
                    async () => {
                      const key = crypto.randomUUID();
                      let uncertain: unknown;
                      try {
                        const outcome = record(await client.request("POST",
                          `${ADMIN}/grants/${encodeURIComponent(grant.id)}/revoke`,
                          { expectedRevision: grant.revision }, { idempotencyKey: key }));
                        if (outcome.state !== "revoked") throw new Error("Gateway did not confirm Grant revocation.");
                      } catch (error) {
                        uncertain = error;
                      }
                      let current: Row | undefined;
                      try {
                        const latest = await loadList(`${ADMIN}/grants`);
                        current = latest.items.find(item => item.id === grant.id);
                      } catch {
                        throw new Error(`Grant revocation unverified. Refresh Grants to inspect the original request ${key}.`);
                      }
                      if (current?.state !== "revoked")
                        throw uncertain ?? new Error(`Grant revocation unverified. Inspect request ${key} before taking another action.`);
                      if (own !== generation) return;
                      await refresh();
                      announce("Grant revoked and verified in the Registry. Reauthorize the connector to regain access.");
                    }, true, "Confirm revoke", td,
                  );
                }, "danger"));
                td.append(revoke);
              },
            },
          ],
          grants.items,
          grantsPanel,
          false,
        );
      } catch {
        if (own !== generation || destroyed || !opened || tab !== "Agents") return;
        grantsPanel.replaceChildren();
        heading("Grants", grantsPanel);
        p("Grant history is temporarily unavailable; pending OAuth approvals remain actionable.", grantsPanel);
      }
    })();
  }
  function mountRetainedRecovery(own: number) {
    if (!client.localRecoveryScopes || !client.inspectLocalRecovery) return;
    if (retainedPanel?.own === own) {
      body.append(retainedPanel.node);
      return;
    }
    const panel = el("section", undefined, "recovery-status");
    retainedPanel = { own, node: panel };
    body.append(panel);
    const active = () => own === generation && tab === "Recovery" && opened && !destroyed;
    async function load() {
      panel.replaceChildren();
      heading("Retained local evidence", panel);
      const summary = el("p", "Reading local recovery records…", "muted");
      panel.append(summary);
      let scopes: HistoricalRecoveryScope[];
      try {
        scopes = await client.localRecoveryScopes!();
      } catch (error) {
        if (active()) summary.textContent = errorText(error);
        return;
      }
      if (!active()) return;
      if (!scopes.length) {
        summary.textContent = "No retained local recovery scopes on this installation.";
        return;
      }
      summary.remove();
      const scopeSelector = select("Retained Binding and Epoch", scopes.map(scope => ({
        value: scope.id,
        label: `${scope.workspaceId} · Assignment ${scope.assignmentGeneration} · Binding ${scope.bindingGeneration} · Epoch ${scope.epoch}`,
      })), scopes.some(scope => scope.id === retainedScopeId) ? retainedScopeId : scopes[0]!.id);
      const evidence = el("div");
      panel.append(scopeSelector.label, evidence);
      let inspectionGeneration = 0;
      async function inspect() {
        const id = scopeSelector.input.value;
        retainedScopeId = id;
        const request = ++inspectionGeneration;
        dismissConfirmation();
        evidence.replaceChildren(el("p", "Reading the selected scope…"));
        let result: HistoricalRecoveryInspection;
        try {
          result = await client.inspectLocalRecovery!(id);
        } catch (error) {
          if (active() && request === inspectionGeneration) evidence.replaceChildren(el("p", errorText(error)));
          return;
        }
        if (!active() || request !== inspectionGeneration || result.scope.id !== id) return;
        evidence.replaceChildren();
        const {scope, revision} = result;
        p(`Native identity digest ${scope.nativeIdentityDigest}`, evidence, "muted");
        p(revision ? `Verified source revision ${revision}` : str(result.sourceError, "Verified source readback unavailable."), evidence, "muted");
        if (client.exportLocalRecovery) evidence.append(button("Export selected local evidence", () =>
          confirmAction(`Download private evidence for Workspace ${scope.workspaceId}, Assignment ${scope.assignmentGeneration}, Binding ${scope.bindingGeneration}, Epoch ${scope.epoch}?`, async () => {
            const data = await client.exportLocalRecovery!(id);
            if (active() && request === inspectionGeneration)
              client.download("perch-local-recovery.json", data, "application/json");
          })));
        for (const row of result.records) {
          const card = el("section", undefined, "recovery-item");
          card.append(el("strong", `${row.kind} · ${row.state}`));
          p(row.id, card, "muted");
          if (row.reason) p(row.reason, card);
          if (row.gatewayOperationId) p(`Gateway Operation ${row.gatewayOperationId}`, card, "muted");
          const describeDigest = (value: string | null | undefined) =>
            value === null ? "verified absent" : value ?? "unknown";
          if (row.expectedDigest !== undefined || row.observedDigest !== undefined)
            p(`Expected pointer digest ${describeDigest(row.expectedDigest)} · observed ${describeDigest(row.observedDigest)}`, card, "muted");
          if (row.paths.length) {
            const details = el("details");
            details.append(el("summary", "File digest evidence"));
            for (const path of row.paths) {
              p(`${path.path} · expected ${describeDigest(path.expectedDigest)} · observed ${describeDigest(path.observedDigest)}`, details);
            }
            card.append(details);
          }
          const acknowledgement = row.acknowledgement;
          if (acknowledgement && client.resolveRetainedLocalHold) card.append(button("Review local Hold", () =>
            confirmAction(`Acknowledge Hold ${row.id} for Workspace ${scope.workspaceId}, Assignment ${scope.assignmentGeneration}, Binding ${scope.bindingGeneration}, Epoch ${scope.epoch} after reviewing the verified source evidence?`, async () => {
              if (!active() || request !== inspectionGeneration) return;
              await client.resolveRetainedLocalHold!(id, row.id, acknowledgement,
                "Operator reviewed the exact retained local Hold and current readback.");
              if (active() && request === inspectionGeneration) await inspect();
            })));
          evidence.append(card);
        }
        if (!result.records.length) p("No pending local Hold or staged publication in this scope.", evidence, "muted");
        if (client.listCheckpoints) {
          const checkpoints = el("section");
          evidence.append(checkpoints);
          heading("Checkpoints", checkpoints);
          try {
            const entries = await client.listCheckpoints(id);
            if (!active() || request !== inspectionGeneration) return;
            if (!entries.length) p("No checkpoints in this Epoch.", checkpoints, "muted");
            for (const entry of entries) {
              const checkpoint = el("section", undefined, "recovery-item");
              checkpoint.append(el("strong", entry.label || entry.id));
              p(`${new Date(entry.createdAt).toLocaleString()} · revision ${entry.revision} · ${entry.pinned ? "Pinned" : "Rotating retention"}`, checkpoint, "muted");
              if (client.exportCheckpoint) checkpoint.append(button("Export checkpoint", async () => {
                const data = await client.exportCheckpoint!(id, entry.id);
                if (active() && request === inspectionGeneration)
                  client.download("perch-checkpoint.json", data, "application/json");
              }));
              if (client.setCheckpointPinned) checkpoint.append(button(entry.pinned ? "Unpin checkpoint" : "Pin checkpoint", async () => {
                await client.setCheckpointPinned!(id, entry.id, !entry.pinned);
                if (active() && request === inspectionGeneration) await inspect();
              }));
              if (client.previewSourceRestore && client.exportCheckpoint && client.restoreSourceBackup) {
                checkpoint.append(remoteButton("Inspect checkpoint restore", own, async () => {
                  const archive = JSON.parse(await client.exportCheckpoint!(id, entry.id));
                  const intent = await client.previewSourceRestore!(archive, "exact-binding");
                  if (!active() || request !== inspectionGeneration) return;
                  requireAuthority(own);
                  confirmAction(`Restore ${intent.fileCount} checkpoint files in Workspace ${scope.workspaceId} at revision ${intent.expectedRevision}?`, async () => {
                    if (!active() || request !== inspectionGeneration) return;
                    await client.restoreSourceBackup!(archive, intent);
                    if (active() && request === inspectionGeneration) await inspect();
                  }, true);
                }));
              }
              checkpoints.append(checkpoint);
            }
          } catch (error) {
            if (active() && request === inspectionGeneration) p(errorText(error), checkpoints);
          }
        }
      }
      on(scopeSelector.input, "change", () => { void inspect(); });
      await inspect();
    }
    void load().catch(error => {
      if (active()) p(errorText(error), panel);
    });
  }
  async function renderRecovery(own:number){
    heading('Connection recovery');
    p('This screen checks what stopped the agent. It never repeats a Save or source edit.',body,'muted');
    mountRetainedRecovery(own);
    if(!workspaces.items.length){p('No Workspaces are configured.',body);return;}
    if(!workspaces.items.some(w=>w.id===recoveryWorkspaceId)){
      try{
        const native=await client.currentIdentity();
        const exact=workspaces.items.filter(w=>{
          const b=record(w.binding);
          return b.generatorId===native.generatorId && b.draftId===native.draftId &&
            b.slug===native.slug && b.browserInstallationId===native.browserInstallationId;
        });
        recoveryWorkspaceId=exact.length===1?str(exact[0]!.id):
          workspaces.items.length===1?str(workspaces.items[0]!.id):'';
      }catch{recoveryWorkspaceId='';}
    }
    if(!recoveryWorkspaceId){
      p('Choose the Workspace to inspect. No operation will be cleared by selecting it.',body);
    }
    const chooser=select('Workspace',[
      {value:'',label:'Select Workspace'},
      ...workspaces.items.map(w=>({
        value:str(w.id),label:str(w.label)+' · '+str(record(w.binding).slug||record(record(w.recoveryBinding).binding).slug||'unbound')
      })),
    ],recoveryWorkspaceId);
    recoveryWorkspaceId=chooser.input.value;
    const toolbar=el('div',undefined,'row recovery-toolbar');
    toolbar.append(chooser.label,button('Refresh status',async()=>refresh()));
    on(chooser.input,'change',()=>{recoveryWorkspaceId=chooser.input.value;void refresh();});
    body.append(toolbar);
    const workspaceId=recoveryWorkspaceId;
    if(!workspaceId)return;
    if (state.assignmentContractVersion===2 && client.exportWorkspaceEvidence)
      toolbar.append(button('Export private Workspace evidence',()=>confirmAction(
        'Download retained source and operation records for this Workspace? Keep the file private.',async()=>{
          const bytes=await client.exportWorkspaceEvidence!(workspaceId);
          client.download('perch-workspace-evidence.json',bytes,'application/json');
        })));
    const snapshot=record(await client.request('GET',`${ADMIN}/workspaces/${encodeURIComponent(workspaceId)}/recovery`));
    if(own!==generation || workspaceId!==recoveryWorkspaceId)return;
    const lease=record(snapshot.activeLease),pending=num(snapshot.pendingClaimUntil);
    const blockers=Array.isArray(snapshot.blockingOperations)
      ?snapshot.blockingOperations.filter(isRecord).map(record):[];
    const action=str(snapshot.action);
    const readable=(value:unknown)=>{
      const time=num(value);
      return time>0?new Date(time).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}):'unknown';
    };
    const statusPanel=el('section',undefined,'recovery-status'),message=el('div',undefined,'recovery-message');
    const lines:Record<string,[string,string]>={
      RECONNECT:['Ready to connect','No Gateway operation is blocking this Workspace.'],
      WAIT_FOR_STORAGE:['Storage preparation pending','Preserve pending results and complete storage activation before reconnecting.'],
      WAIT_FOR_TERMINAL:['Work still settling','A previous operation has not finished. Its result will be checked before reconnecting.'],
      RECONCILE:['Review needed','A previous operation has an uncertain result. Check its effects before continuing.'],
    };
    const [title,description]=lines[action]??['Checking connection','Inspect the current lease and pending operations below.'];
    message.append(el('strong',title),el('p',description));
    if(lease.expiresAt) p(`Another editor has the lease until ${readable(lease.expiresAt)}. Leave it running or wait for release.`,message,'muted');
    else if(pending) p(`Connection claim should settle around ${readable(pending)}.`,message,'muted');
    statusPanel.append(message);
    if(action==='RECONNECT')statusPanel.append(button('Connect now',async()=>{
      const w=workspaces.items.find(item=>item.id===workspaceId);
      if(!w)throw new Error('Workspace changed. Refresh first.');
      await connectWorkspace(w);
    },'primary'));
    else if(action==='WAIT_FOR_TERMINAL'||action==='WAIT_FOR_STORAGE')statusPanel.append(button('Check again',async()=>refresh()));
    body.append(statusPanel);
    if(blockers.length){
      heading('Operations requiring attention');
      for(const a of blockers){
        const item=el('section',undefined,'recovery-item'),row=el('div',undefined,'recovery-item-head');
        const label=el('div');label.append(el('strong',str(a.tool,'Unknown operation')),
          el('p',`Status: ${str(a.phase,'unknown')}`, 'muted'));
        row.append(label);
        item.append(row);
        if(a.resolvable===true && client.reconcileOperation){
          p('Open the assigned generator and compare its current source and saved state. If the result looks correct, acknowledge the uncertainty to let the agent continue.',item);
          const review=button('I checked the result — continue',async()=>{
            // The controller independently verifies exact native identity,
            // revision and digest, then records this deliberate acknowledgement.
            const evidence='Operator explicitly acknowledged uncertain operation after being instructed to inspect current Generator/source/provider state; '+
              'acknowledgement at '+new Date().toISOString()+'.';
            await client.reconcileOperation!({workspaceId,operationId:str(a.operationId),
              epoch:num(a.epoch),bindingRevision:num(a.bindingRevision),
              tool:str(a.tool),operatorEvidence:evidence});
            await refresh();announce('Result acknowledged. Remaining holds are unchanged.');
          },'primary');
          item.append(review);
        }else if(a.resolvable!==true) p('Still running. Wait for the deadline, then refresh. No manual reset is needed.',item,'muted');
        else p('This editor cannot inspect the current source. Reconnect the assigned editor, then refresh; no effect has been cleared.',item,'muted');
        const details=el('details'),summary=el('summary','Technical details');
        details.append(summary);
        p(`Operation ID: ${str(a.operationId)} · epoch ${str(a.epoch)} · binding ${str(a.bindingRevision)}`,details,'muted');
        p('Deadline: '+readable(a.deadlineMs),details,'muted');
        item.append(details);body.append(item);
      }
    }
    if(!client.localRecovery)return;
    let local: Awaited<ReturnType<NonNullable<ManagerClient['localRecovery']>>>;
    try{local=await client.localRecovery(workspaceId);}
    catch{
      const note=el('details');note.append(el('summary','Local journal status unavailable'));
      p('Open the exact assigned generator and draft, then refresh. No local journal is being cleared.',note,'muted');
      body.append(note);return;
    }
    if(own!==generation)return;
    if(!local.holds.length){p('Local editor journal: no pending holds.',body,'muted');return;}
    heading('Local editor changes');
    p('These unsaved-file records are separate from Gateway operations.',body,'muted');
    for(const a of local.holds){
      const item=el('section',undefined,'recovery-item');
      item.append(el('strong',`${a.kind} · ${a.state}`));
      p('Affected files: '+a.paths.slice(0,6).join(', '),item,'muted');
      p('Check those files in the native editor before continuing. This will not reapply changes.',item);
      if(local.sourceError)p('Source readback unavailable ('+local.sourceError+'). Connection can continue, but these edits cannot be acknowledged until exact bytes are readable.',item,'muted');
      if(client.resolveLocalHold && local.revision && !local.sourceError)item.append(button('I checked these files — continue',async()=>{
        const evidence='Operator explicitly acknowledged local-file journal uncertainty after being instructed to inspect '+a.kind+
          '; acknowledgement at '+new Date().toISOString()+'.';
        await client.resolveLocalHold!(workspaceId,a.id,local.revision,evidence);
        await refresh();announce('Local hold acknowledged. No other operations were cleared.');
      },'primary'));
      const details=el('details');details.append(el('summary','Technical details'));
      p(`Journal ${a.id} · base ${a.baseRevision} · current ${local.revision}`,details,'muted');
      item.append(details);body.append(item);
    }
  }
  async function renderActivity(own: number) {
    const response = list(await client.request("GET", `${ADMIN}/activity`,undefined,{signal:viewAbort?.signal}));
    if (own !== generation) return;
    if(lastKnown?.installation===installation()){
      lastKnown.activity=response.items.slice(0,100).map(row=>({operationId:str(row.operationId).slice(0,128),tool:str(row.tool).slice(0,80),phase:str(row.phase).slice(0,40)}));
    }
    heading("Activity");
    p(
      "Operation outcomes are authoritative. An unknown provider effect must not be replayed. Other operations can continue while current editor source is verified. Cancelling cannot undo a dispatched provider effect.",
      body,
      "muted",
    );
    search();
    const renderRows=(items:Row[])=>table(
      [
        {
          key: "timestamp",
          label: "Time / Workspace",
          render(a, td) {
            p(str(a.timestamp), td);
            p(str(a.workspaceId), td, "muted");
          },
        },
        {
          key: "operationId",
          label: "Operation",
          render(a, td) {
            p(str(a.operationId), td);
            p(str(a.tool), td, "muted");
          },
        },
        {
          key: "phase",
          label: "Outcome",
          render(a, td) {
            p(
              `${str(a.phase)} ${a.durationMs === undefined ? "" : `· ${str(a.durationMs)} ms`}`,
              td,
            );
            p(str(a.errorCode), td);
            if (a.phase === "UNKNOWN" || a.phase === "PARTIAL") {
              p(
                a.tool === "set_viewport_size"
                  ? "Viewport-only: verify native iframe dimensions. The original PARTIAL outcome remains recorded; gateway v0.1.5+ permits recovery without treating this as a generator writer effect."
                  : "Inspect the native draft and independent provider readback. Do not repeat the mutation.",
                td,
              );
              if (record(a.resolution).resolvedByOperator === true)
                p(
                  "Operator resolution recorded. The original effect remains uncertain.",
                  td,
                );
              else if (client.reconcileOperation)
                td.append(
                  button("Resolve uncertain operation…", async () => {
                    const box = el("div", undefined, "confirm");
                    p(
                      "Inspect the source and provider state before resolving. This records your decision and permits a fresh lease; it does not assert success or replay the operation.",
                      box,
                    );
                    const evidence = field("Inspection evidence (required)");
                    evidence.input.maxLength = 512;
                    const acknowledgement = el("label", undefined, "check-row"),
                      checkbox = el("input");
                    checkbox.type = "checkbox";
                    acknowledgement.append(
                      checkbox,
                      doc.createTextNode(
                        "I inspected source and provider state; record resolution without asserting success.",
                      ),
                    );
                    box.append(
                      evidence.label,
                      acknowledgement,
                      button("Record operator resolution", async () => {
                        if (!checkbox.checked || !evidence.input.value.trim())
                          throw new Error(
                            "Inspection evidence and explicit uncertainty acknowledgement are required.",
                          );
                        await client.reconcileOperation!({
                          ...a,
                          operatorEvidence: evidence.input.value.trim(),
                        });
                        await refresh();
                        announce(
                          "Operator resolution recorded. The original effect remains uncertain; reconnect the Workspace explicitly.",
                        );
                      }),
                      button("Cancel resolution", () => box.remove()),
                    );
                    td.append(box);
                    evidence.input.focus();
                  }),
                );
            }
          },
        },
      ],
      items,
    );
    renderRows(response.items);
    let cursor=response.cursor;
    if(cursor){
      const nextButton=button('Load next page',async()=>{
        if(!cursor)return;
        const next=list(await client.request('GET',`${ADMIN}/activity?cursor=${encodeURIComponent(cursor)}`));
        if(next.revision!==response.revision)
          throw new Error('Activity changed during pagination. Refresh and try again.');
        if(own!==generation)return;
        renderRows(next.items);
        cursor=next.cursor;
        if(!cursor)nextButton.remove();
      });
      body.append(nextButton);
    }
    if (client.localArtifacts) {
      const artifacts = await client.localArtifacts();
      if (own !== generation) return;
      heading("Local file attachments");
      p(
        "Attachments remain private in this browser. Downloading does not publish a URL.",
        body,
        "muted",
      );
      table(
        [
          { key: "name", label: "File" },
          { key: "workspaceId", label: "Workspace" },
          { key: "bytes", label: "Bytes" },
          {
            key: "id",
            label: "Download",
            render(a, td) {
              td.append(
                button("Download file", async () => {
                  if (!client.downloadArtifact)
                    throw new Error(
                      "Local attachment download is unavailable.",
                    );
                  await client.downloadArtifact(str(a.id));
                  announce("Attachment download started.");
                }),
              );
            },
          },
        ],
        artifacts,
      );
    }
    body.append(
      button("Export complete diagnostics (OAuth + network)", exportDiagnostics),
      button("Export MCP operation activity only", async () => {
        client.download(
          "perch-mcp-activity.json",
          json({
            schemaVersion: 1,
            items: response.items.map((a) => ({
              operationId: a.operationId,
              workspaceId: a.workspaceId,
              tool: a.tool,
              phase: a.phase,
              errorCode: a.errorCode,
              timestamp: a.timestamp,
              durationMs: a.durationMs,
            })),
          }),
          "application/json",
        );
      }),
    );
  }
  async function exportDiagnostics(): Promise<void> {
    const report = await buildDiagnosticReport(client, options.version, status, authority?.generation!==generation);
    client.download("perch-mcp-diagnostics.json", json(report), "application/json");
    announce("Redacted diagnostic report exported, including OAuth audit and transport failures.");
  }
  async function promptCredential(
    purpose: "bootstrap" | "recovery",
  ): Promise<string | null> {
    if (!client.promptSecret)
      throw new Error(
        "The isolated browser credential prompt is unavailable. Pairing and recovery remain disabled; no page credential input is provided.",
      );
    try {
      return await client.promptSecret(purpose);
    } catch {
      throw new Error(
        "The isolated credential prompt could not be opened. No credentials were submitted.",
      );
    }
  }
  function renderPrivateFiles(parent: HTMLElement) {
    if (!client.stagePrivateFile || !client.listPrivateFiles) return;
    const own = generation;
    const section = el("section");
    const inventory = el("div");
    const file = field("Private file", "", "file");
    const destination = field("Scratch path", "scratch/");
    const current = () => own === generation && section.isConnected;
    heading("Private files", section);
    on(file.input, "change", () => {
      const name = file.input.files?.[0]?.name;
      if (name && destination.input.value === "scratch/") destination.input.value = "scratch/" + name;
    });
    async function refreshInventory() {
      const entries = await client.listPrivateFiles!();
      if (!current()) return;
      inventory.replaceChildren();
      for (const entry of entries) {
        const row = el("div", undefined, "row");
        const digest = el("span", `${entry.path} · ${entry.bytes} bytes · ${entry.state}`);
        digest.title = entry.sha256;
        row.append(digest);
        if (client.previewPrivateFileImport && client.importPrivateFile) {
          row.append(remoteButton("Review private import", own, async () => {
            const intent = await client.previewPrivateFileImport!(entry.id);
            if (!current()) return;
            requireAuthority(own);
            confirmAction(`Import ${intent.bytes} verified bytes to ${intent.path} in the current Binding?`, async () => {
              const imported = await client.importPrivateFile!(entry.id, intent.expectedLocalRevision);
              if (current()) {
                await refreshInventory();
                announce(`Private file imported at LocalRevision ${imported.localRevision}.`);
              }
            }, true);
          }));
        }
        inventory.append(row);
      }
      if (!entries.length) p("No staged private files.", inventory, "muted");
    }
    actions(section, file.label, destination.label, button("Stage private file", async () => {
      const selected = file.input.files?.[0];
      if (!selected) throw new Error("Choose a file to stage.");
      if (selected.size > 16 * 1024 * 1024) throw new Error("Private file exceeds the 16 MiB file limit.");
      const path = destination.input.value;
      const bytes = new Uint8Array(await selected.arrayBuffer());
      if (!current()) return;
      const staged = await client.stagePrivateFile!(path, bytes);
      if (current()) {
        file.input.value = "";
        await refreshInventory();
        announce(`Staged ${staged.bytes} bytes · SHA-256 ${staged.sha256}.`);
      }
    }));
    section.append(inventory);
    parent.append(section);
    void refreshInventory().catch(error => {
      if (current()) p(errorText(error), inventory);
    });
  }
  function renderSettings() {
    heading("Setup and Settings");
    const config = client.configuration();
    p(
      `Userscript ${options.version} · Gateway ${authority?.generation===generation?str(state.version,"unverified"):"unverified"} · schema ${authority?.generation===generation?str(state.schemaVersion,"unverified"):"unverified"}`,
      body,
      "muted",
    );
    const connected=authority?.generation===generation && authority.installation===installation();
    const rollout=record(state.rollout);
    const activation=el("section",undefined,"recovery-status");
    heading("Rollout and capability state",activation);
    p("Authoritative Gateway status: "+(connected?"Loaded now":"UNVERIFIED/OFFLINE"),activation,"muted");
    p("Assignment contract: "+(connected?str(state.assignmentContractVersion) === '2'?'v2':'legacy':'unknown'),activation);
    p("19-tool v2 execution: "+(connected?
      rollout.developmentContractV2ExecutionEnabled===true?"Enabled":
      rollout.developmentContractV2ExecutionEnabled===false?"Disabled":"not reported":"unknown"),activation);
    p("Canonical storage: "+(connected?str(rollout.canonicalStorageMode,"not reported"):"unknown"),activation,"muted");
    const boolStatus=(value:unknown)=>!connected||typeof value!=="boolean"?"unknown":value?"enabled":"disabled";
    p("Push: "+boolStatus(rollout.pushNotificationsEnabled)+
      " · binary payloads: "+boolStatus(rollout.binaryPayloadsEnabled)+
      " · admission estimates: "+boolStatus(rollout.admissionBudgetEnabled),activation,"muted");
    p("Preview pixels: UNSUPPORTED_INTERFACE until an authorized actual-pixel provider is accepted. Production provider effects require OWNER acceptance. Account quota remains unknown.",activation,"muted");
    body.append(activation);
    const instructions = el("details");
    instructions.open = !config.paired;
    instructions.append(el("summary", "Installation steps"));
    for (const step of [
      "Deploy the released Cloudflare gateway package with its bindings and a unique BOOTSTRAP_SECRET. No local service is needed.",
      "Enter the exact HTTPS gateway origin. Check compatibility, then pair with its one-time secret.",
      "Create a Connector, assign a Workspace and explicitly bind the ready native editor. Copy the Connector URL.",
      "Authorize the external MCP Connector, approve the matching request in Connectors, then call workspace_status.",
    ])
      p(step, instructions);
    body.append(instructions);
    const origin = field("Gateway HTTPS origin", config.origin, "url");
    origin.input.placeholder = "https://perch-mcp.example.workers.dev";
    origin.input.autocomplete = "off";
    const row = el("div", undefined, "row");
    row.append(
      origin.label,
      button("Check gateway", async () => {
        const result = record(
          await client.health(validateOrigin(origin.input.value)),
        );
        const pre = el(
          "pre",
          json({
            version: result.version,
            schemaVersion: result.schemaVersion,
            protocolVersion: result.protocolVersion,
            status: result.status,
            paired: result.paired,
            compatible: result.compatible,
          }),
        );
        body.append(pre);
        announce(
          "Gateway health retrieved. Pairing still requires the one-time secret.",
        );
      }),
    );
    body.append(row);
    if (!config.paired) {
      const pairRow = el("div", undefined, "row");
      p(
        "Enter the one-time bootstrap secret only in the isolated browser credential prompt opened by Pair installation. This page never renders a credential input.",
        body,
        "muted",
      );
      pairRow.append(
        button(
          "Pair installation",
          async () => {
            const gatewayOrigin = validateOrigin(origin.input.value);
            const value = await promptCredential("bootstrap");
            if (value === null) {
              announce("Pairing cancelled.");
              return;
            }
            if (value.length < 43 || value.length > 256)
              throw new Error(
                "Use the deployment’s unique high-entropy bootstrap secret (43–256 characters).",
              );
            await client.pair(gatewayOrigin, value);
            tab = "Workspaces";
            updateTabs();
            await refresh();
            announce("Paired. Attach this editor to a Workspace.");
          },
          "primary",
        ),
      );
      body.append(pairRow);
    } else
      p(
        `Paired with ${config.origin}. Credentials remain in isolated userscript storage and are excluded from exports.`,
      );
    if (client.recover) {
      const recovery = el("details");
      recovery.append(el("summary", "Recover installation credentials"));
      p(
        "First rotate RECOVERY_SECRET in the Cloudflare dashboard to a fresh password-manager-generated secret of at least 32 random bytes (43 base64url characters). Recovery uses the HTTPS gateway origin above.",
        recovery,
      );
      p(
        "Recovery revokes all previous management/execution credentials, Grants and leases. The Resource library remains stored. Workspaces stay paused and require explicit rebinding and new connector authorization before resuming.",
        recovery,
      );
      p(
        "After confirming revocation, enter the rotated recovery secret in the isolated browser credential prompt. Never paste it into the Perchance document.",
        recovery,
        "muted",
      );
      const acknowledgement = el("label", undefined, "check-row"),
        approveRecovery = el("input");
      approveRecovery.type = "checkbox";
      approveRecovery.setAttribute("aria-label", "Approve recovery revocation");
      acknowledgement.append(
        approveRecovery,
        doc.createTextNode(
          "I rotated RECOVERY_SECRET and approve revoking all existing credentials, Grants and leases.",
        ),
      );
      const recover = button(
        "Confirm credential recovery",
        async () => {
          if (!approveRecovery.checked)
            throw new Error(
              "Confirm the specific credential, Grant and lease revocation before recovery.",
            );
          approveRecovery.checked = false;
          const gatewayOrigin = validateOrigin(origin.input.value);
          const value = await promptCredential("recovery");
          if (value === null) {
            announce("Recovery cancelled.");
            return;
          }
          if (value.length < 43 || value.length > 256)
            throw new Error(
              "Enter the fresh high-entropy recovery secret (43–256 characters).",
            );
          await client.pauseLocal?.();
          await client.recover!(gatewayOrigin, value);
          setStatus({
            connection: "paused",
            reason: "Credentials recovered. Rebind Workspaces before resuming.",
          });
          await refresh();
          announce(
            "Credentials recovered. Previous credentials, Grants and leases are revoked. The library is preserved; explicitly rebind and authorize connectors before resuming.",
          );
        },
        "danger",
      );
      recovery.append(acknowledgement, recover);
      body.append(recovery);
    }
    actions(
      body,
      button("Export complete diagnostics (OAuth + network)", exportDiagnostics),
      button("Read-only editor probe", async () => {
        // The probe must remain available when native identity is missing.
        const probe = client.probe ? await client.probe() : undefined;
        let identity:
          | Awaited<ReturnType<ManagerClient["currentIdentity"]>>
          | undefined;
        let identityError: string | undefined;
        try {
          identity = await client.currentIdentity();
        } catch (error) {
          identityError = error instanceof Error ? error.message : String(error);
        }
        body.append(
          el(
            "pre",
            json({
              identity: identity
                ? {
                    generatorId: identity.generatorId,
                    slug: identity.slug,
                    publicId: identity.publicId,
                    draftId: identity.draftId,
                  }
                : null,
              identityError,
              probe,
            }),
          ),
        );
        announce(
          identityError
            ? "Native identity unavailable; read-only capability report follows."
            : "Native identity read without source mutation.",
        );
      }),
      button("Export settings", async () => {
        client.download(
          "perch-mcp-settings.json",
          exportSafeSettings(client.configuration(), options.version),
          "application/json",
        );
      }),
      button("Export source backup separately", async () => {
        if (!client.sourceBackup)
          throw new Error(
            "The native source backup adapter is unavailable. No backup has been created.",
          );
        const backup = await client.sourceBackup();
        client.download(
          "perch-mcp-source-backup.json",
          json(backup),
          "application/json",
        );
      }),
    );
    if (client.localDrafts) {
      // Never initialize or expose a legacy Library on fresh installations.
      // Read-only export appears only if retained historical drafts actually exist.
      const archive=el("section");
      body.append(archive);
      const own=generation;
      void client.localDrafts().then(value => {
        if(own!==generation || !archive.isConnected) return;
        const old=record(value);
        const rows=Array.isArray(old.drafts)?old.drafts:Array.isArray(old.documents)?old.documents:[];
        if(rows.length===0) return;
        const disclosure=el("details");
        disclosure.append(el("summary","Historical unpublished Resource drafts"));
        p("This is read-only recovery evidence. No Resource editor or publication controls are installed.",disclosure,"muted");
        disclosure.append(button("Export unpublished Resource drafts",async()=>{
          const current=await client.localDrafts!();
          client.download("perch-mcp-resource-drafts.json",json(current),"application/json");
          announce("Historical Resource drafts exported. Published Resources and settings are unchanged.");
        }));
        archive.append(disclosure);
      }).catch(()=>undefined);
    }
    if (client.restoreSourceBackup) {
      const own = generation;
      const backupInput = el("input");
      const restoreMode = select("Restore scope", [
        {value: "exact-binding", label: "Exact Binding with verified private files"},
        {value: "source-only", label: "Native source only"},
      ], "exact-binding");
      backupInput.type = "file";
      backupInput.accept = ".json";
      backupInput.hidden = true;
      backupInput.setAttribute("aria-label", "Restore source backup");
      on(backupInput, "change", () => {
        const file = backupInput.files?.[0];
        if (!file) return;
        void run(async () => {
          if (file.size > 64 * 1024 * 1024)
            throw new Error(
              "Source backup exceeds the local 64 MiB input budget.",
            );
          const backup: unknown = JSON.parse(await file.text());
          if (own !== generation || !backupInput.isConnected) return;
          if (client.previewSourceRestore) {
            requireAuthority(own);
            const mode = restoreMode.input.value === "source-only" ? "source-only" : "exact-binding";
            const intent = await client.previewSourceRestore(backup, mode);
            if (own !== generation || !backupInput.isConnected) return;
            requireAuthority(own);
            confirmAction(
              `Restore ${intent.fileCount} ${mode === "source-only" ? "native source" : "verified Binding"} files at revision ${intent.expectedRevision}?`,
              async () => {
                await client.restoreSourceBackup!(backup, intent);
                announce("Source backup restore verified.");
              }, true);
            return;
          }
          confirmAction(
            "Restore this source backup to the current native draft? The adapter must verify identity and current revision. This does not Save.",
            async () => {
              await client.restoreSourceBackup!(backup);
              announce("Source backup restore verified.");
            },
          );
        });
      });
      body.append(
        backupInput,
        ...(client.previewSourceRestore ? [restoreMode.label,
          markRemote(button("Restore source backup…", () => backupInput.click()))] :
          [button("Restore source backup…", () => backupInput.click())]),
      );
    }
    renderPrivateFiles(body);
    const settingsInput = el("input");
    settingsInput.type = "file";
    settingsInput.accept = ".json";
    settingsInput.hidden = true;
    settingsInput.setAttribute("aria-label", "Import settings");
    on(settingsInput, "change", () => {
      const file = settingsInput.files?.[0];
      if (!file) return;
      void run(async () => {
        if (file.size > 16384)
          throw new Error("Settings import exceeds 16 KiB.");
        const imported = record(JSON.parse(await file.text()));
        if (
          imported.schemaVersion !== 1 ||
          typeof imported.gatewayOrigin !== "string"
        )
          throw new Error("Unsupported settings format.");
        const gatewayOrigin = validateOrigin(imported.gatewayOrigin);
        confirmAction(
          "Import this gateway origin? Installation credentials and Bindings are not restored. Pairing and explicit rebinding are required.",
          async () => {
            if (!client.importSettings)
              throw new Error(
                "Settings import is unavailable in this controller.",
              );
            await client.importSettings({ schemaVersion: 1, gatewayOrigin });
            await refresh();
          },
        );
      });
    });
    body.append(
      settingsInput,
      button("Import settings…", () => settingsInput.click()),
    );
    if (config.paired && client.disconnect)
      body.append(
        button(
          "Disconnect this installation locally",
          async () => {
            confirmAction(
              "Remove local pairing credentials? The gateway remains deployed. Revoke existing Grants separately before disconnecting.",
              async () => {
                await client.pauseLocal?.();
                await client.disconnect!();
                setStatus({ connection: "unpaired" });
                await refresh();
              },
            );
          },
          "danger",
        ),
      );
    if (client.fetchHosts && client.setFetchHosts) {
      const hostPanel = el("details");
      hostPanel.append(el("summary", "Approved public fetch hosts"));
      p(
        "Approve exact trusted public hostnames only, one per line. Subdomains require their own entry. No URLs, wildcards, IP addresses, or local names. Removing every entry denies all public fetches.",
        hostPanel,
      );
      p(
        "DNS trust: browser JavaScript cannot independently attest DNS addresses. Approve only hosts whose DNS and service you trust; an approved host can receive Agent-selected requests. No credentials are forwarded, redirects remain denied, and POST still requires FETCH_POST.",
        hostPanel,
        "muted",
      );
      const hostLabel = el("label", "Exact approved public hostnames"),
        hosts = el("textarea");
      hosts.setAttribute("aria-label", "Exact approved public hostnames");
      hosts.spellcheck = false;
      hosts.disabled = true;
      hosts.style.minHeight = "100px";
      hostLabel.append(hosts);
      const resizeHosts = () => fitTextarea(hosts);
      on(hosts, "input", resizeHosts);
      const saveHosts = button("Save approved fetch hosts", async () => {
        const entries = [
          ...new Set(
            hosts.value
              .split(/\r?\n/)
              .map((value) => value.trim().toLowerCase())
              .filter(Boolean),
          ),
        ];
        if (entries.length > 64)
          throw new Error("The approved-host budget is 64 exact hostnames.");
        for (const host of entries) {
          const parsed = validatePublicFetchUrl(`https://${host}/`, [host]);
          if (
            parsed.hostname !== host ||
            parsed.host !== host ||
            parsed.pathname !== "/" ||
            parsed.search ||
            parsed.hash ||
            host.split(".").some((label) => label.length > 63)
          )
            throw new Error(
              "Enter exact public hostnames only, without schemes, paths, ports or credentials.",
            );
        }
        await client.setFetchHosts!(entries);
        hosts.value = entries.join("\n");
        resizeHosts();
        announce(
          "Approved fetch hosts saved. Existing permissions still apply.",
        );
      });
      saveHosts.disabled = true;
      hostPanel.append(hostLabel, saveHosts);
      body.append(hostPanel);
      const renderedGeneration = generation;
      void client
        .fetchHosts()
        .then((values) => {
          if (
            destroyed ||
            renderedGeneration !== generation ||
            !hostPanel.isConnected
          )
            return;
          hosts.value = values.join("\n");
          hosts.disabled = false;
          saveHosts.disabled = false;
          resizeHosts();
        })
        .catch((error) => {
          if (hostPanel.isConnected) report(error);
        });
    }
    const budget = el("details");
    budget.append(el("summary", "Execution limits and recovery"));
    p(
      "Queue: 8 pending operations per Workspace. Interactive deadline: 30 seconds. Transport message: 512 KiB. Checkpoints: bounded local retention. Current deployment configuration remains authoritative.",
      budget,
    );
    p(
      "Gateway outage: local inspection, recovery, export and native manual editing remain available. Remote mutations require fresh authority. Unknown effects stay held until read-only reconciliation.",
      budget,
    );
    p(
      "Credential loss: rotate RECOVERY_SECRET in Cloudflare, use the documented recovery procedure, then re-pair and rebind. Cloudflare version rollback does not restore stored data.",
      budget,
    );
    body.append(budget);
    if (config.paired) {
      heading("Remote execution");
      actions(
        body,
        remoteButton(
          state.paused ? "Resume all Workspaces" : "Pause all Workspaces", generation,
          async () => {
            const own=generation;
            const paused=state.paused===true, revision=num(state.policyRevision);
            if (!paused) await client.pauseLocal?.();
            requireAuthority(own);
            await client.request("POST", `${ADMIN}/pause`, {
              expectedRevision: revision,
              paused: !paused,
            });
            await refresh();
            announce(
              state.paused
                ? "New dispatches paused. Already-dispatched effects require reconciliation."
                : "New dispatches enabled.",
            );
          },
          "danger",
        ),
        button("Stop this document immediately",stopLocal,"danger"),
      );
    }
  }
  function close() {
    if (!opened) return;
    stopApprovalRefresh();
    dismissConfirmation();
    authority = undefined;
    viewAbort?.abort();
    opened = false;
    ++generation;
    try {
      dialog.close();
    } catch {
      dialog.removeAttribute("open");
    }
    if (previousFocus && previousFocus.isConnected && "focus" in previousFocus)
      (previousFocus as HTMLElement).focus();
    else launcher.focus();
  }
  async function open(next?: Tab) {
    if (destroyed) return;
    if (next && !buttons.has(next)) throw new Error("Unknown manager tab.");
    if (next) tab = next;
    if (!opened) {
      previousFocus = doc.activeElement;
      opened = true;
      try {
        dialog.showModal();
      } catch {
        dialog.setAttribute("open", "");
      }
    }
    updateTabs();
    await refresh();
    if (opened) buttons.get(tab)?.focus();
  }
  const closeButton = button("Close", close);
  closeButton.classList.add("push");
  head.append(title, statusNode, closeButton);
  for (const name of [
    "Workspaces",
    "Agents",
    "Activity",
    "Recovery",
    "Settings",
  ] as Tab[]) {
    const b = button(name, async () => {
      tab = name;
      filterValue = "";
      updateTabs();
      await refresh();
    });
    b.setAttribute("role", "tab");
    buttons.set(name, b);
    nav.append(b);
  }
  nav.setAttribute("role", "tablist");
  foot.append(notice);
  dialog.append(head, nav, body, foot);
  shadow.append(launcher, dialog);
  (options.root ?? doc.body ?? doc.documentElement).append(host);
  on(launcher, "click", () => {
    void open();
  });
  on(dialog, "cancel", (e) => {
    e.preventDefault();
    close();
  });
  on(dialog, "keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === "Tab") {
      const candidates = [
        ...dialog.querySelectorAll<HTMLElement>(
          'button,input,select,textarea,a[href],[tabindex="0"]',
        ),
      ].filter(
        (n) =>
          !n.hasAttribute("disabled") &&
          !n.hasAttribute("hidden") &&
          !n.closest("details:not([open])"),
      );
      const first = candidates[0],
        last = candidates.at(-1);
      if (e.shiftKey && shadow.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && shadow.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    }
  });
  on(nav, "keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const names = [...buttons.keys()];
    let i = names.indexOf(tab);
    i =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? names.length - 1
          : (i + (e.key === "ArrowRight" ? 1 : -1) + names.length) %
            names.length;
    tab = names[i]!;
    buttons.get(tab)?.focus();
    updateTabs();
    void refresh();
  });
  const onVisibilityChange=()=>{
    if(doc.visibilityState==="hidden"){
      stopApprovalRefresh();
      authority=undefined;
      dismissConfirmation();
      refreshRemoteButtons();
    } else if(opened && !destroyed && tab==="Agents") {
      // Returning to a visible Connector pane must reacquire current approval
      // and Grant authority; do not replay a request from the hidden view.
      void refresh();
    } else if(opened && !destroyed) refreshRemoteButtons();
  };
  doc.addEventListener("visibilitychange",onVisibilityChange);
  doc.defaultView?.addEventListener("resize", fitVisibleTextareas);
  on(dialog, "toggle", fitVisibleTextareas, true);
  setStatus(status);
  return {
    open,
    close,
    refresh,
    setStatus,
    destroy() {
      stopApprovalRefresh();
      dismissConfirmation();
      authority = undefined;
      destroyed = true;
      opened = false;
      ++generation;
      doc.defaultView?.removeEventListener("resize", fitVisibleTextareas);
      doc.removeEventListener("visibilitychange",onVisibilityChange);
      host.remove();
    },
  };
}
function bytesToBase64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 16384)
    text += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return btoa(text);
}
