import { managerStyles } from "./manager.css";
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
export interface ManagerClient {
  /** Adds management credential, JSON type and a fresh Idempotency-Key for writes. Never redirects credentials. */
  request(method: string, path: string, body?: unknown): Promise<unknown>;
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
  restoreSourceBackup?(backup: unknown): Promise<void>;
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
  connection: "unpaired" | "connected" | "paused" | "offline" | "blocked";
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
type Tab = "Workspaces" | "Agents" | "Library" | "Activity" | "Settings";
type Row = Record<string, unknown>;
interface List {
  items: Row[];
  revision: number;
  cursor?: string | null;
}
interface ResourceDraft {
  id: string;
  title: string;
  description: string;
  kind: string;
  enabled: boolean;
  body: string;
  files: Record<string, string>;
  revision: number;
  dependencies: string[];
  provenance: string;
  license: string;
  upstreamVersion?: string;
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
  const [health, stateResult, remote] = await Promise.all([
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
  const local = record(client.diagnostics?.());
  const localEvents = Array.isArray(local.events) ? local.events.slice(-100).filter(isRecord)
    .map((event) => ({
      at: num(event.at),
      method: ["GET", "POST", "PATCH", "PUT", "DELETE"].includes(str(event.method)) ? event.method : "other",
      route: /^\/(?:api\/v1\/(?:admin|tab)\/|health$)/.test(str(event.route))
        ? str(event.route).split("?")[0]!.slice(0, 120)
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
      }),
    },
    oauthAudit: { ok: remote.ok, ...(!remote.ok ? { error: remote } : {}), events },
    transport: { events: localEvents },
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
  let resourceLoad = 0;
  let approvalRefreshTimer: ReturnType<typeof setInterval> | undefined;
  function stopApprovalRefresh() {
    if (approvalRefreshTimer !== undefined) clearInterval(approvalRefreshTimer);
    approvalRefreshTimer = undefined;
  }
  let generation = 0,
    destroyed = false,
    opened = false,
    previousFocus: Element | null = null,
    state: Row = {},
    workspaces: List = { items: [], revision: 0 },
    agents: List = { items: [], revision: 0 };
  let draft: ResourceDraft | undefined,
    draftBaseline: ResourceDraft | undefined,
    draftBase = "",
    draftFile = "",
    draftPending: Promise<void> = Promise.resolve(),
    editorDirty = false;
  let sortField = "label",
    sortDirection = 1,
    filterValue = "",
    confirmedAction: (() => Promise<void>) | undefined;
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
    if (target) target.disabled = true;
    try {
      await action();
    } catch (e) {
      report(e);
    } finally {
      if (target?.isConnected) target.disabled = false;
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
  function confirmAction(message: string, action: () => Promise<void>) {
    confirmedAction = action;
    const box = el("div", undefined, "confirm");
    box.setAttribute("role", "alert");
    p(message, box);
    box.append(
      button(
        "Confirm",
        async () => {
          const current = confirmedAction;
          confirmedAction = undefined;
          box.remove();
          await current?.();
        },
        "danger",
      ),
      button("Cancel", () => {
        confirmedAction = undefined;
        box.remove();
      }),
    );
    body.prepend(box);
    box.querySelector("button")?.focus();
  }
  function copy(label: string, value: string) {
    return button(label, async () => {
      await client.copy(value);
      announce("Copied.");
    });
  }
  function setStatus(next: ManagerStatus) {
    status = next;
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
  function sorted(items: Row[]) {
    return items
      .filter((r) =>
        json(r).toLocaleLowerCase().includes(filterValue.toLocaleLowerCase()),
      )
      .sort(
        (a, b) =>
          str(a[sortField]).localeCompare(str(b[sortField])) * sortDirection,
      );
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
    const t = el("table"),
      thead = el("thead"),
      tr = el("tr"),
      tbody = el("tbody");
    for (const c of columns) {
      const th = el("th");
      th.scope = "col";
      const b = button(c.label, async () => {
        sortDirection = sortField === c.key ? -sortDirection : 1;
        sortField = c.key;
        await refresh();
      });
      b.setAttribute("aria-label", `Sort by ${c.label}`);
      th.append(b);
      tr.append(th);
    }
    thead.append(tr);
    t.append(thead, tbody);
    for (const row of useFilter ? sorted(rows) : rows) {
      const r = el("tr");
      for (const c of columns) {
        const td = el("td");
        if (c.render) c.render(row, td);
        else td.textContent = str(row[c.key], "—");
        r.append(td);
      }
      tbody.append(r);
    }
    parent.append(t);
    if (!rows.length) p("No entries.", parent, "empty");
  }
  function search(parent = body) {
    const f = field("Filter", filterValue, "search");
    on(f.input, "change", () => {
      filterValue = f.input.value;
      void refresh();
    });
    const row = el("div", undefined, "row");
    row.append(f.label, button("Refresh", refresh));
    parent.append(row);
  }
  async function loadList(path: string): Promise<List> {
    let response = list(await client.request("GET", path));
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
          `${path}?cursor=${encodeURIComponent(response.cursor)}`,
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
  async function baseData() {
    const [s, w, a] = await Promise.all([
      client.request("GET", `${ADMIN}/state`),
      loadList(`${ADMIN}/workspaces`),
      loadList(`${ADMIN}/agents`),
    ]);
    return { s: record(s), w: list(w), a: list(a) };
  }
  async function refresh() {
    stopApprovalRefresh();
    const own = ++generation;
    if (!opened || destroyed) return;
    announce("Loading…");
    if (tab === "Settings") {
      body.replaceChildren();
      renderSettings();
    }
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
      const base = await baseData();
      if (own !== generation || destroyed) return;
      state = base.s;
      workspaces = base.w;
      agents = base.a;
      body.replaceChildren();
      if (tab === "Workspaces") renderWorkspaces();
      if (tab === "Agents") await renderAgents(own);
      if (tab === "Library") await renderLibrary(own);
      if (tab === "Activity") await renderActivity(own);
      if (tab === "Settings") renderSettings();
      if (own === generation) announce("Updated.");
    } catch (e) {
      if (own !== generation) return;
      report(e);
      if (!body.children.length) {
        heading("Gateway unavailable");
        p(
          "Normal Perchance editing remains available. Close this manager to continue. Reconnect from Settings.",
        );
        body.append(
          button("Settings", async () => {
            tab = "Settings";
            updateTabs();
            body.replaceChildren();
            renderSettings();
          }),
        );
      }
    }
  }
  function updateTabs() {
    body.setAttribute("role", "tabpanel");
    body.setAttribute("aria-label", tab);
    for (const [name, b] of buttons)
      b.setAttribute("aria-selected", String(name === tab));
  }
  function permissionEditor(parent: HTMLElement, values: string[]) {
    const box = el("div", undefined, "permissions");
    const checks = new Map<string, HTMLInputElement>();
    for (const permission of PERMISSIONS) {
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
  function renderWorkspaces() {
    heading("Workspaces");
    p(
      "Attach the current editor to one Workspace. Rebinding revokes previous Grants and fences the previous document.",
      body,
      "muted",
    );
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
    body.append(form);
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
            const bind = async (replace: boolean) => {
              // Do not change the authoritative remote Binding until the
              // current editor has passed a read-only native capability check.
              const probed = client.probe ? record(await client.probe()) : null;
              if (probed && (probed.ready !== true || !probed.identity))
                throw new Error(
                  "The native editor is not ready for attachment. Open Settings → Read-only editor probe to inspect the missing capability.",
                );
              const identity = await client.currentIdentity();
              const configured = client.configuration();
              const binding = {
                ...identity,
                browserInstallationId:
                  identity.browserInstallationId ??
                  configured.browserInstallationId,
              };
              if (!binding.browserInstallationId)
                throw new Error(
                  "The browser installation identity is unavailable; pair again before attaching.",
                );
              const result = record(
                await client.request(
                  "POST",
                  `${ADMIN}/workspaces/${encodeURIComponent(str(w.id))}/bind`,
                  { expectedRevision: num(w.revision), binding, replace },
                ),
              );
              await client.attach?.({ ...w, ...result });
              await refresh();
            };
            actions(
              td,
              button(
                w.binding ? "Rebind current editor" : "Attach current editor",
                async () => {
                  if (w.binding)
                    confirmAction(
                      "Replace this Binding with the current editor? Previous Grants will be revoked. Any uncertain operation remains held.",
                      () => bind(true),
                    );
                  else await bind(false);
                },
              ),
              button(w.paused ? "Resume" : "Pause", async () => {
                await client.request(
                  "PATCH",
                  `${ADMIN}/workspaces/${encodeURIComponent(str(w.id))}`,
                  { expectedRevision: num(w.revision), paused: !w.paused },
                );
                await refresh();
              }),
              button("Reconnect", async () => {
                await client.attach?.(w);
                announce(
                  "Reconnect requested. Identity and lease checks still apply.",
                );
              }),
              button(
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
              ),
            );
            const details = el("details"),
              summary = el("summary", "Rename / permissions");
            details.append(summary);
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
    heading("Agents and OAuth");
    p(
      "One Agent targets one Workspace. Connector reuse across conversations shares its Grant and queue.",
      body,
      "muted",
    );
    const row = el("div", undefined, "row"),
      name = field("Agent name"),
      target = select(
        "Workspace",
        workspaces.items
          .filter((w) => !w.agentId)
          .map((w) => ({ value: str(w.id), label: str(w.label) })),
      );
    name.input.maxLength = 80;
    row.append(
      name.label,
      target.label,
      button("Create Agent", async () => {
        if (!name.input.value.trim() || !target.input.value)
          throw new Error("Enter a name and select an unassigned Workspace.");
        await client.request("POST", `${ADMIN}/agents`, {
          label: name.input.value.trim(),
          workspaceId: target.input.value,
        });
        await refresh();
      }),
    );
    body.append(row);
    search();
    table(
      [
        {
          key: "label",
          label: "Agent",
          render(a, td) {
            p(str(a.label), td);
            p(str(a.id), td, "muted");
          },
        },
        {
          key: "workspaceId",
          label: "Connector",
          render(a, td) {
            const url = endpoint(client.configuration().origin, a),
              input = field("MCP connector URL", url);
            input.input.readOnly = true;
            td.append(input.label);
            actions(
              td,
              copy("Copy URL", url),
              copy(
                "Copy setup instructions",
                `Create a custom remote MCP connector with URL ${url}. Complete OAuth, then approve the matching code in Perch MCP → Agents. Verify workspace_status before editing. Tokens remain in the client.`,
              ),
            );
            p(
              `Workspace: ${str(workspaces.items.find((w) => w.id === a.workspaceId)?.label, str(a.workspaceId))}`,
              td,
              "muted",
            );
          },
        },
        {
          key: "suspended",
          label: "Actions",
          render(a, td) {
            const label = field("Agent label", str(a.label));
            td.append(label.label);
            actions(
              td,
              button("Rename", async () => {
                await client.request(
                  "PATCH",
                  `${ADMIN}/agents/${encodeURIComponent(str(a.id))}`,
                  {
                    expectedRevision: num(a.revision),
                    label: label.input.value.trim(),
                  },
                );
                await refresh();
              }),
              button(
                a.suspended ? "Resume Agent" : "Suspend Agent",
                async () => {
                  await client.request(
                    "PATCH",
                    `${ADMIN}/agents/${encodeURIComponent(str(a.id))}`,
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
    const approvalPanel = el("section");
    const grantsPanel = el("section");
    body.append(approvalPanel, grantsPanel);
    let lastApprovalState = "";
    const loadApprovals = async () => {
      const approvals = await loadList(`${ADMIN}/approvals`);
      if (own !== generation || destroyed || !opened || tab !== "Agents")
        return;
      const pending = approvals.items.filter(
        (item) => item.state === "pending" && num(item.expiresAt) > Date.now(),
      );
      const fingerprint = JSON.stringify(pending);
      if (fingerprint === lastApprovalState) return; // Preserve focus while polling.
      lastApprovalState = fingerprint;
      approvalPanel.replaceChildren();
      heading("Pending approvals", approvalPanel);
      p(
        "This list refreshes automatically while Agents is open. Match the code, Client and callback before approving.",
        approvalPanel,
        "muted",
      );
      table(
        [
          {
            key: "code",
            label: "Request",
            render(a, td) {
              p(`${str(a.kind)} · ${str(a.code)}`, td);
              p(`Agent ${str(a.agentId)} · Workspace ${str(a.workspaceId)}`, td);
              p(
                `Client ${str(a.clientId)} · expires ${str(a.expiresAt)}`,
                td,
                "muted",
              );
            },
          },
          {
            key: "digest",
            label: "Exact authorization",
            render(a, td) {
              p(`Redirect: ${str(a.redirectUri)}`, td);
              p(
                `Scope: ${Array.isArray(a.scope) ? arrayStrings(a.scope).join(", ") : str(a.scope)}`,
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
              actions(
                td,
                button("Approve exact request", async () => {
                  await client.request(
                    "POST",
                    `${ADMIN}/approvals/${encodeURIComponent(str(a.id))}/decision`,
                    {
                      expectedRevision: num(a.revision) || approvals.revision,
                      digest: str(a.digest),
                      decision: "approve",
                    },
                  );
                  await refresh();
                }),
                button(
                  "Deny",
                  async () => {
                    await client.request(
                      "POST",
                      `${ADMIN}/approvals/${encodeURIComponent(str(a.id))}/decision`,
                      {
                        expectedRevision: num(a.revision) || approvals.revision,
                        digest: str(a.digest),
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
      );
    };
    const showApprovalsFailure = (error: unknown) => {
      if (own !== generation || !opened || destroyed || tab !== "Agents") return;
      if (!approvalPanel.textContent?.includes("Pending approvals")) {
        approvalPanel.replaceChildren();
        heading("Pending approvals", approvalPanel);
        p("Could not retrieve approvals. Automatic retry is active.", approvalPanel);
      }
      announce(errorText(error), true);
    };
    // Never overlap requests: a stalled gateway must not pile up polling
    // calls, reorder snapshots or amplify its own outage.
    let approvalInFlight = false;
    const pollApprovals = async () => {
      if (approvalInFlight) return;
      approvalInFlight = true;
      try {
        await loadApprovals();
      } catch (error) {
        showApprovalsFailure(error);
      } finally {
        approvalInFlight = false;
      }
    };
    await pollApprovals();
    if (own !== generation || destroyed || !opened || tab !== "Agents") return;
    approvalRefreshTimer = setInterval(() => {
      void pollApprovals();
    }, 4000);
    // Never make synthetic Node test runners wait on the UI's polling timer.
    (approvalRefreshTimer as unknown as { unref?: () => void }).unref?.();
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
              label: "Agent / Workspace",
              render(g, td) {
                p(`${str(g.agentId)} / ${str(g.workspaceId)}`, td);
                p(str(g.clientId), td, "muted");
              },
            },
            {
              key: "state",
              label: "Authorization",
              render(g, td) {
                p(`${str(g.state)} · expires ${str(g.expiresAt)}`, td);
              },
            },
            {
              key: "id",
              label: "Actions",
              render(g, td) {
                td.append(
                  button(
                    "Revoke Grant",
                    async () => {
                      await client.request(
                        "POST",
                        `${ADMIN}/grants/${encodeURIComponent(str(g.id))}/revoke`,
                        { expectedRevision: num(g.revision) },
                      );
                      await refresh();
                    },
                    "danger",
                  ),
                );
              },
            },
          ],
          grants.items,
          grantsPanel,
        );
      } catch {
        if (own !== generation || destroyed || !opened || tab !== "Agents") return;
        grantsPanel.replaceChildren();
        heading("Grants", grantsPanel);
        p("Grant history is temporarily unavailable; pending OAuth approvals remain actionable.", grantsPanel);
      }
    })();
  }
  function normalizeResource(value: Row): ResourceDraft {
    const files: Record<string, string> = Object.create(null) as Record<
      string,
      string
    >;
    for (const [path, content] of Object.entries(record(value.files)))
      if (typeof content === "string") files[path] = content;
    return {
      id: str(value.id),
      kind: str(value.kind, "document"),
      title: str(value.title, str(value.id)),
      description: str(value.description),
      enabled: value.enabled !== false,
      body: str(value.body),
      files,
      revision: num(value.revision),
      dependencies: arrayStrings(value.dependencies),
      provenance: str(value.provenance),
      license: str(value.license, "operator-provided"),
      ...(typeof value.upstreamVersion === "string"
        ? { upstreamVersion: value.upstreamVersion }
        : {}),
    };
  }
  async function openResource(value: Row) {
    const load = ++resourceLoad;
    const loaded = record(
      await client.request(
        "GET",
        `${ADMIN}/resources/${encodeURIComponent(str(value.id))}`,
      ),
    );
    if (load !== resourceLoad || destroyed) return;
    draft = normalizeResource(Object.keys(loaded).length ? loaded : value);
    draftBase = draft.body;
    draftBaseline = structuredClone(draft);
    draftFile = "";
    editorDirty = false;
    const saved = await client.drafts?.get(`resource:${draft.id}`);
    if (load !== resourceLoad || destroyed) return;
    if (saved) {
      try {
        const parsed = record(JSON.parse(saved));
        if (parsed.id === draft.id) {
          const restored = normalizeResource(parsed);
          if (restored.revision === draft.revision) {
            draft = restored;
            editorDirty = true;
            announce(
              "Recovered unpublished Resource draft. Other document drafts remain available through Settings → Export unpublished Resource drafts.",
            );
          } else
            announce(
              "An unpublished draft from another revision is retained. Export it before replacing the current draft.",
              true,
            );
        }
      } catch {
        announce(
          "A malformed Resource draft is retained. Export it from Settings before cleanup.",
          true,
        );
      }
    }
    await refresh();
    if (load === resourceLoad) focusResourceEditor();
  }
  function focusResourceEditor() {
    const area = body.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Resource text"]',
    );
    const panel = area?.closest<HTMLElement>(".editor");
    if (!area || !panel || !opened) return;
    fitTextarea(area, 140);
    area.focus({ preventScroll: true });
    body.scrollTop +=
      panel.getBoundingClientRect().top - body.getBoundingClientRect().top - 10;
  }
  function saveDraft() {
    if (!draft) return;
    editorDirty = true;
    const key = `resource:${draft.id}`,
      value = json(draft);
    draftPending = draftPending
      .then(() => client.drafts?.set(key, value))
      .then(() => undefined)
      .catch(report);
  }
  async function renderLibrary(own: number) {
    const response = await loadList(`${ADMIN}/resources`);
    if (own !== generation) return;
    state.libraryRevision = response.revision;
    heading("Library");
    p(
      "Resources are editable instructions, not security policy. Publishing creates a new revision. Local drafts survive a failed publish.",
      body,
      "muted",
    );
    search();
    const createRow = el("div", undefined, "row"),
      id = field("New Resource ID"),
      kind = select(
        "Kind",
        ["skill", "workflow", "instruction", "document"].map((value) => ({
          value,
          label: value,
        })),
      );
    createRow.append(
      id.label,
      kind.label,
      button("Create Resource", async () => {
        if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(id.input.value))
          throw new Error(
            "Use 1–80 lowercase letters, digits, or hyphens for the Resource ID.",
          );
        const created = record(
          await client.request("POST", `${ADMIN}/resources`, {
            resource: {
              id: id.input.value,
              kind: kind.input.value,
              title: id.input.value,
              description: "",
              body: "",
              files: {},
              enabled: true,
              dependencies: [],
              provenance: "Operator-authored",
              license: "operator-provided",
            },
          }),
        );
        await openResource(created);
      }),
    );
    body.append(createRow);
    actions(
      body,
      button("Export Library ZIP", async () => {
        if (client.exportResources)
          client.download(
            "perch-mcp-library.zip",
            await client.exportResources(),
            "application/zip",
          );
        else {
          const exported = await client.request(
            "GET",
            `${ADMIN}/resources/export`,
          );
          client.download(
            "perch-mcp-library.json",
            json(exported),
            "application/json",
          );
        }
      }),
      button("Import Library…", () => {
        importFile.click();
      }),
    );
    const importFile = el("input");
    importFile.type = "file";
    importFile.accept = ".zip,application/zip";
    importFile.hidden = true;
    importFile.setAttribute("aria-label", "Import Library package");
    on(importFile, "change", () => {
      const file = importFile.files?.[0];
      if (file) void run(() => previewImport(file, response.revision));
    });
    body.append(importFile);
    table(
      [
        {
          key: "id",
          label: "Resource",
          render(r, td) {
            td.append(button(str(r.title, str(r.id)), () => openResource(r)));
            p(str(r.id), td, "muted");
          },
        },
        {
          key: "kind",
          label: "Kind / revision",
          render(r, td) {
            p(
              `${str(r.kind)} · revision ${str(r.revision)} · ${r.enabled === false ? "disabled" : "enabled"}`,
              td,
            );
            p(str(r.description), td, "muted");
          },
        },
        {
          key: "id",
          label: "Actions",
          render(r, td) {
            actions(
              td,
              button("Duplicate", async () => {
                const copyId = `${str(r.id).slice(0, 60)}-copy-${Date.now().toString(36)}`;
                const full = record(
                  await client.request(
                    "GET",
                    `${ADMIN}/resources/${encodeURIComponent(str(r.id))}`,
                  ),
                );
                const value = normalizeResource({ ...full, id: copyId });
                const created = record(
                  await client.request("POST", `${ADMIN}/resources`, {
                    resource: {
                      ...value,
                      revision: undefined,
                      dependencies: full.dependencies ?? [],
                    },
                  }),
                );
                await openResource(created);
              }),
              button(r.enabled === false ? "Enable" : "Disable", async () => {
                const full = record(
                  await client.request(
                    "GET",
                    `${ADMIN}/resources/${encodeURIComponent(str(r.id))}`,
                  ),
                );
                await client.request(
                  "PUT",
                  `${ADMIN}/resources/${encodeURIComponent(str(r.id))}`,
                  {
                    expectedRevision: num(r.revision),
                    resource: {
                      ...normalizeResource(full),
                      revision: undefined,
                      enabled: r.enabled === false,
                    },
                  },
                );
                await refresh();
              }),
              button(
                "Delete",
                async () => {
                  confirmAction(
                    `Delete Resource ${str(r.id)}? Active dependencies may block deletion.`,
                    async () => {
                      await client.request(
                        "POST",
                        `${ADMIN}/resources/${encodeURIComponent(str(r.id))}/delete`,
                        { expectedRevision: num(r.revision) },
                      );
                      if (draft?.id === r.id) draft = undefined;
                      await refresh();
                    },
                  );
                },
                "danger",
              ),
            );
          },
        },
      ],
      response.items,
    );
    if (draft) renderEditor();
  }
  function renderEditor() {
    const current = draft!;
    const panel = el("section", undefined, "editor");
    heading(`Edit ${current.id}`, panel);
    p(
      `Base revision ${current.revision}${editorDirty ? " · unpublished draft" : ""}`,
      panel,
      "muted",
    );
    const row = el("div", undefined, "row"),
      title = field("Resource title", current.title),
      description = field("Description", current.description);
    on(title.input, "input", () => {
      current.title = title.input.value;
      saveDraft();
    });
    on(description.input, "input", () => {
      current.description = description.input.value;
      saveDraft();
    });
    row.append(title.label, description.label);
    panel.append(row);
    const meta = el("details");
    meta.append(el("summary", "Resource metadata"));
    const metadataRow = el("div", undefined, "row"),
      dependencies = field(
        "Dependency Resource IDs (comma separated)",
        current.dependencies.join(", "),
      ),
      provenance = field("Provenance", current.provenance),
      license = field("License / redistribution terms", current.license);
    on(dependencies.input, "input", () => {
      current.dependencies = dependencies.input.value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      saveDraft();
    });
    on(provenance.input, "input", () => {
      current.provenance = provenance.input.value;
      saveDraft();
    });
    on(license.input, "input", () => {
      current.license = license.input.value;
      saveDraft();
    });
    metadataRow.append(dependencies.label, provenance.label, license.label);
    meta.append(metadataRow);
    panel.append(meta);
    const grid = el("div", undefined, "editor-grid"),
      fileList = el("div", undefined, "file-list"),
      main = el("div"),
      areaLabel = el("label", "Resource text"),
      area = el("textarea");
    area.spellcheck = false;
    area.setAttribute("aria-label", "Resource text");
    area.value = draftFile ? (current.files[draftFile] ?? "") : current.body;
    areaLabel.append(area);
    main.append(areaLabel);
    for (const path of ["", ...Object.keys(current.files).sort()]) {
      const b = button(path || "Main text", async () => {
        draftFile = path;
        await refresh();
        focusResourceEditor();
      });
      b.setAttribute("aria-pressed", String(path === draftFile));
      fileList.append(b);
    }
    const fileName = field("Reference file path");
    fileList.append(
      fileName.label,
      button("Add text file", async () => {
        const path = fileName.input.value;
        if (
          !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(path) ||
          path
            .split("/")
            .some(
              (p) =>
                !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(p) ||
                p === "." ||
                p === ".." ||
                ["constructor", "prototype", "__proto__"].includes(p),
            ) ||
          Object.keys(current.files).some(
            (p) => p.toLowerCase() === path.toLowerCase(),
          )
        )
          throw new Error("Enter a unique relative path without traversal.");
        current.files[path] = "";
        draftFile = path;
        saveDraft();
        await refresh();
        focusResourceEditor();
      }),
    );
    area.dataset.autoGrowMinimum = "140";
    const fit = () => fitTextarea(area, 140);
    on(area, "input", () => {
      if (draftFile) current.files[draftFile] = area.value;
      else current.body = area.value;
      saveDraft();
      fit();
    });
    queueMicrotask(fit);
    grid.append(fileList, main);
    panel.append(grid);
    actions(
      panel,
      button(
        "Publish revision",
        async () => {
          await draftPending;
          const saved = record(
            await client.request(
              "PUT",
              `${ADMIN}/resources/${encodeURIComponent(current.id)}`,
              {
                expectedRevision: current.revision,
                resource: {
                  id: current.id,
                  kind: current.kind,
                  title: current.title,
                  description: current.description,
                  enabled: current.enabled,
                  body: current.body,
                  files: current.files,
                  dependencies: current.dependencies,
                  provenance: current.provenance,
                  license: current.license,
                  ...(current.upstreamVersion
                    ? { upstreamVersion: current.upstreamVersion }
                    : {}),
                },
              },
            ),
          );
          await client.drafts?.delete(`resource:${current.id}`);
          draft = normalizeResource(saved);
          draftBase = draft.body;
          draftBaseline = structuredClone(draft);
          editorDirty = false;
          await refresh();
          announce("Published new Resource revision.");
        },
        "primary",
      ),
      button("Compare draft", async () => {
        const details = el("details");
        details.open = true;
        details.append(el("summary", "Draft difference"));
        const parts: [string, string, string][] = [
          ["Main text", draftBase, current.body],
          ...[
            ...new Set([
              ...Object.keys(draftBaseline?.files ?? {}),
              ...Object.keys(current.files),
            ]),
          ]
            .sort()
            .map(
              (path) =>
                [
                  path,
                  draftBaseline?.files[path] ?? "",
                  current.files[path] ?? "",
                ] as [string, string, string],
            ),
        ];
        let changed = false;
        for (const [path, before, after] of parts) {
          if (before === after) continue;
          changed = true;
          details.append(el("h3", path));
          const pre = el("pre");
          for (const line of lineDiff(before, after))
            pre.append(
              el(
                "span",
                `${line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "} ${line.text}\n`,
                `diff-${line.kind}`,
              ),
            );
          details.append(pre);
        }
        if (
          draftBaseline &&
          (draftBaseline.title !== current.title ||
            draftBaseline.description !== current.description ||
            draftBaseline.dependencies.join(",") !==
              current.dependencies.join(",") ||
            draftBaseline.provenance !== current.provenance ||
            draftBaseline.license !== current.license)
        ) {
          changed = true;
          p(
            "Resource metadata changed. Review the metadata fields before publishing.",
            details,
          );
        }
        if (!changed) p("No changes.", details);
        panel.append(details);
      }),
      button("Preview text", async () => {
        const details = el("details");
        details.open = true;
        details.append(
          el("summary", "Safe text preview"),
          renderResourcePreview(
            doc,
            draftFile ? (current.files[draftFile] ?? "") : current.body,
          ),
        );
        panel.append(details);
      }),
      button("Revision history", async () => {
        const histories = list(
          await client.request(
            "GET",
            `${ADMIN}/resources/${encodeURIComponent(current.id)}/history`,
          ),
        );
        table(
          [
            { key: "revision", label: "Revision" },
            { key: "hash", label: "Digest" },
            {
              key: "revision",
              label: "Restore",
              render(r, td) {
                td.append(
                  button("Restore as new revision", async () => {
                    confirmAction(
                      `Restore Resource ${current.id} revision ${str(r.revision)} as a new revision?`,
                      async () => {
                        const saved = record(
                          await client.request(
                            "POST",
                            `${ADMIN}/resources/${encodeURIComponent(current.id)}/restore`,
                            {
                              expectedRevision: current.revision,
                              historicalRevision: num(r.revision),
                            },
                          ),
                        );
                        draft = normalizeResource(saved);
                        draftBase = draft.body;
                        draftBaseline = structuredClone(draft);
                        editorDirty = false;
                        await refresh();
                      },
                    );
                  }),
                );
              },
            },
          ],
          histories.items,
          panel,
        );
      }),
      button("Close editor", async () => {
        await draftPending;
        draft = undefined;
        draftFile = "";
        await refresh();
      }),
    );
    if (draftFile)
      actions(
        panel,
        button(
          "Remove selected reference file",
          async () => {
            delete current.files[draftFile];
            draftFile = "";
            saveDraft();
            await refresh();
          },
          "danger",
        ),
      );
    const assignment = el("details");
    assignment.append(el("summary", "Resource assignment"));
    p(
      "Global → Workspace → Agent. A more specific Resource with the same ID replaces the broader assignment.",
      assignment,
      "muted",
    );
    const ar = el("div", undefined, "row"),
      scope = select("Assignment scope", [
        { value: "global", label: "Global" },
        { value: "workspace", label: "Workspace" },
        { value: "agent", label: "Agent" },
      ]),
      target = select("Assignment target", [
        { value: "", label: "Global" },
        ...workspaces.items.map((w) => ({
          value: str(w.id),
          label: `Workspace: ${str(w.label)}`,
        })),
        ...agents.items.map((a) => ({
          value: str(a.id),
          label: `Agent: ${str(a.label)}`,
        })),
      ]);
    const updateTargets = () => {
      const entries =
        scope.input.value === "global"
          ? [{ value: "", label: "Global" }]
          : (scope.input.value === "workspace"
              ? workspaces.items
              : agents.items
            ).map((e) => ({ value: str(e.id), label: str(e.label) }));
      target.input.replaceChildren(
        ...entries.map((e) => {
          const option = el("option", e.label);
          option.value = e.value;
          return option;
        }),
      );
    };
    on(scope.input, "change", updateTargets);
    updateTargets();
    ar.append(
      scope.label,
      target.label,
      button("Enable Resource at scope", async () => {
        await client.request("POST", `${ADMIN}/resources/assign`, {
          expectedRevision: num(state.libraryRevision),
          resourceId: current.id,
          scopeType: scope.input.value,
          scopeId: scope.input.value === "global" ? "" : target.input.value,
          enabled: true,
        });
        await refresh();
        announce("Resource assignment updated.");
      }),
      button("Disable Resource at scope", async () => {
        await client.request("POST", `${ADMIN}/resources/assign`, {
          expectedRevision: num(state.libraryRevision),
          resourceId: current.id,
          scopeType: scope.input.value,
          scopeId: scope.input.value === "global" ? "" : target.input.value,
          enabled: false,
        });
        await refresh();
        announce("Resource disabled at selected scope.");
      }),
    );
    assignment.append(ar);
    panel.append(assignment);
    body.append(panel);
  }
  async function previewImport(file: File, expectedRevision: number) {
    if (file.size > 8 * 1024 * 1024)
      throw new Error("Import exceeds the 8 MiB compressed input limit.");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const preview = record(
      client.importPreview
        ? await client.importPreview(bytes)
        : await client.request("POST", `${ADMIN}/resources/import/preview`, {
            archiveBase64: bytesToBase64(bytes),
          }),
    );
    const panel = el("section", undefined, "editor");
    heading(`Import preview: ${file.name}`, panel);
    p(
      `${file.size.toLocaleString()} input bytes. No changes have been published.`,
      panel,
    );
    const entries = Array.isArray(preview.items)
      ? preview.items.filter(isRecord)
      : Array.isArray(preview.entries)
        ? preview.entries.filter(isRecord)
        : [];
    const decisions: Record<
      string,
      {
        action: string;
        newId?: string;
      }
    > = {};
    table(
      [
        { key: "id", label: "Resource" },
        {
          key: "status",
          label: "Action / size",
          render(r, td) {
            p(
              `${str(r.action, str(r.status))} · ${str(r.bytes, str(r.size))} bytes`,
              td,
            );
            p(str(r.reason), td);
          },
        },
        {
          key: "id",
          label: "Conflict decision",
          render(r, td) {
            if (r.action === "excluded") {
              td.textContent = "Excluded";
              return;
            }
            const choice = select(`Decision for ${str(r.id)}`, [
              { value: "skip", label: "Keep existing / skip" },
              { value: "replace", label: "Replace with imported revision" },
              { value: "fork", label: "Create customized fork" },
            ]);
            decisions[str(r.id)] = {
              action: r.action === "add" ? "replace" : "skip",
            };
            choice.input.value = r.action === "add" ? "replace" : "skip";
            on(choice.input, "change", () => {
              decisions[str(r.id)] = {
                action: choice.input.value,
                ...(choice.input.value === "fork"
                  ? {
                      newId: `${str(r.id).slice(0, 60)}-import-${Date.now().toString(36)}`,
                    }
                  : {}),
              };
            });
            td.append(choice.label);
          },
        },
      ],
      entries,
      panel,
      false,
    );
    if (!entries.length) panel.append(el("pre", json(preview)));
    actions(
      panel,
      button(
        "Commit reviewed import",
        async () => {
          await client.request("POST", `${ADMIN}/resources/import`, {
            expectedRevision,
            archiveBase64: bytesToBase64(bytes),
            decisions,
          });
          await refresh();
          announce("Library import committed.");
        },
        "primary",
      ),
      button("Cancel import", () => {
        panel.remove();
      }),
    );
    body.prepend(panel);
    panel.scrollIntoView?.({ block: "start" });
  }
  async function renderActivity(own: number) {
    const response = list(await client.request("GET", `${ADMIN}/activity`));
    if (own !== generation) return;
    heading("Activity");
    p(
      "Operation outcomes are authoritative. UNKNOWN requires reconciliation before another mutation. Cancelling a request cannot undo a dispatched provider effect.",
      body,
      "muted",
    );
    search();
    table(
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
                "Inspect the native draft and independent provider readback. Do not repeat the mutation.",
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
      response.items,
    );
    if (response.cursor)
      body.append(
        button("Load next page", async () => {
          const next = list(
            await client.request(
              "GET",
              `${ADMIN}/activity?cursor=${encodeURIComponent(response.cursor!)}`,
            ),
          );
          const pre = el("pre", json(next.items));
          body.append(pre);
        }),
      );
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
    const report = await buildDiagnosticReport(client, options.version, status);
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
  function renderSettings() {
    heading("Setup and Settings");
    const config = client.configuration();
    p(
      `Userscript ${options.version} · Gateway ${str(state.version, "unverified")} · schema ${str(state.schemaVersion, "unverified")}`,
      body,
      "muted",
    );
    p(
      "Candidate verification gate: native preview execution, unsaved preview pixel capture, and external provider effects remain gated until their required Firefox/provider evidence passes. A connected gateway does not establish functional parity.",
      body,
      "muted",
    );
    const instructions = el("details");
    instructions.open = !config.paired;
    instructions.append(el("summary", "Installation steps"));
    for (const step of [
      "Deploy the released Cloudflare gateway package with its bindings and a unique BOOTSTRAP_SECRET. No local service is needed.",
      "Enter the exact HTTPS gateway origin. Check compatibility, then pair with its one-time secret.",
      "Open Workspaces and attach the current native editor. Create an Agent and copy its connector URL.",
      "Authorize the external MCP connector, approve the matching request code in Agents, then call workspace_status.",
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
      p(
        "Unpublished Resource drafts from concurrent documents remain separate. Export them before manually recovering an older draft; this export does not replace settings, source backups or the published Library.",
        body,
        "muted",
      );
      body.append(
        button("Export unpublished Resource drafts", async () => {
          const drafts = await client.localDrafts!();
          client.download(
            "perch-mcp-resource-drafts.json",
            json(drafts),
            "application/json",
          );
          announce(
            "Unpublished Resource drafts exported separately. Published Resources and settings are unchanged.",
          );
        }),
      );
    }
    if (client.restoreSourceBackup) {
      const backupInput = el("input");
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
        button("Restore source backup…", () => backupInput.click()),
      );
    }
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
      "Queue: 8 pending operations per Workspace. Interactive deadline: 30 seconds. Transport message: 512 KiB. Resource import: 16 MiB expanded / 500 entries. Initial checkpoints: 64 MiB total. Current deployment configuration remains authoritative.",
      budget,
    );
    p(
      "Gateway outage: close this manager and keep editing normally. Reconnect verifies identity and obtains a fresh Epoch. Unknown effects stay held until read-only reconciliation.",
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
        button(
          state.paused ? "Resume all Workspaces" : "Pause all Workspaces",
          async () => {
            if (!state.paused) await client.pauseLocal?.();
            await client.request("POST", `${ADMIN}/pause`, {
              expectedRevision: num(state.policyRevision),
              paused: !state.paused,
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
        button(
          "Stop this document immediately",
          async () => {
            await client.pauseLocal?.();
            setStatus({
              ...status,
              connection: "paused",
              reason: "Local stop requested",
            });
            announce(
              "Local admissions stopped. Previously dispatched effects may still complete.",
            );
          },
          "danger",
        ),
      );
    }
  }
  function close() {
    if (!opened) return;
    stopApprovalRefresh();
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
    "Library",
    "Activity",
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
      destroyed = true;
      opened = false;
      ++generation;
      doc.defaultView?.removeEventListener("resize", fitVisibleTextareas);
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
