import { APP_VERSION } from "../../../packages/contracts/src/index.js";
import { NativeAdapter } from "./adapter.js";
import { resolveNativePageRealm } from "./page-context.js";
import { GMStore } from "./storage.js";
import { GatewayTransport, gatewayOrigin } from "./transport.js";
import { BrowserController } from "./controller.js";
import { DocumentDraftStore } from "./resource-drafts.js";
import { RuntimeTools } from "./runtime-tools.js";
import {
  mountManager,
  type ManagerClient,
  type ManagerHandle,
} from "./manager.js";

declare const unsafeWindow: Window;
declare const cloneInto:
  | ((value: unknown, target: unknown) => unknown)
  | undefined;
declare const GM_info: {
  injectInto?: string;
  version?: string;
  scriptHandler?: string;
};
declare function GM_getValue(key: string): unknown;
declare function GM_setValue(key: string, value: unknown): void;
declare function GM_deleteValue(key: string): void;
declare function GM_listValues(): string[];
declare function GM_registerMenuCommand(
  label: string,
  callback: () => void,
): unknown;
declare function GM_setClipboard(text: string): void;

async function start(): Promise<void> {
  if (
    window.top !== window.self ||
    location.origin !== "https://perchance.org" ||
    /^\/(?:ai-agent|upload|login|signup)(?:\/|$)/.test(location.pathname)
  )
    return;
  const store = new GMStore({
    getValue: GM_getValue,
    setValue: GM_setValue,
    deleteValue: GM_deleteValue,
    listValues: GM_listValues,
  });
  const transport = new GatewayTransport(store);
  let initializationError = false;
  try {
    await transport.initialize();
  } catch {
    initializationError = true;
  }
  const page = resolveNativePageRealm(
    window,
    typeof unsafeWindow !== "undefined" ? unsafeWindow : undefined,
  );
  const adapter = new NativeAdapter(page, {
    cloneInto:
      typeof cloneInto === "function" ? (v) => cloneInto(v, page) : undefined,
    externalWritesVerified: false,
  });
  let manager: ManagerHandle | undefined;
  const runtime = new RuntimeTools(page, store, document);
  const controller = new BrowserController(
    adapter,
    store,
    transport,
    runtime,
    (status) => manager?.setStatus(status),
  );
  const download = (name: string, data: string | Uint8Array, mime: string) => {
    const blob = new Blob(
      [typeof data === "string" ? data : (data.slice().buffer as ArrayBuffer)],
      { type: mime },
    );
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.rel = "noopener";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  };
  const client: ManagerClient = {
    request: (method, path, body) => transport.request(method, path, body),
    health: (origin) => transport.health(origin),
    diagnostics: () => ({
      ...transport.diagnostics(),
      browser: controller.diagnostics(),
    }),
    promptSecret: async (purpose) => {
      if (typeof GM_info === "undefined" || GM_info.injectInto !== "content")
        throw new Error(
          "Verified isolated Violentmonkey content context is required for credential entry.",
        );
      // The native prompt is obtained from the isolated controller Window, never unsafeWindow.
      return window.prompt(
        purpose === "bootstrap"
          ? "Perch MCP: enter the one-time bootstrap secret for the gateway shown in Settings."
          : "Perch MCP: enter the newly rotated recovery secret. Existing Grants and leases will be revoked.",
      );
    },
    pair: (origin, secret) => transport.pair(origin, secret),
    recover: async (origin, secret) => {
      await controller.pause();
      await transport.recover(origin, secret);
    },
    configuration: () => transport.configuration(),
    currentIdentity: async () => ({
      ...(await adapter.identity()),
      browserInstallationId: await transport.installationId(),
    }),
    attach: async (workspace) => {
      if (typeof GM_info === "undefined" || GM_info.injectInto !== "content")
        throw new Error(
          "Verified Violentmonkey content injection is required; the native editor remains available.",
        );
      const health = (await transport.health()) as { schemaVersion?: number };
      if (health.schemaVersion !== 1)
        throw new Error("Gateway protocol/schema incompatible.");
      await controller.attach(workspace);
    },
    pauseLocal: () => controller.pause(),
    copy: async (text) => GM_setClipboard(text),
    download,
    drafts: new DocumentDraftStore(store, controller.tabInstanceId),
    localDrafts: () =>
      new DocumentDraftStore(store, controller.tabInstanceId).export(),
    probe: async () => ({
      ...(await adapter.probe()),
      manager: {
        name:
          typeof GM_info === "undefined" ? "unknown" : GM_info.scriptHandler,
        version: typeof GM_info === "undefined" ? "unknown" : GM_info.version,
        injectInto:
          typeof GM_info === "undefined" ? "unknown" : GM_info.injectInto,
      },
      externalVerification: "Pending T3; no production-write gate enabled.",
    }),
    disconnect: async () => {
      await controller.pause();
      await transport.disconnect();
    },
    sourceBackup: () => controller.sourceBackup(),
    reconcileOperation: (operation) => controller.reconcileOperation(operation),
    restoreSourceBackup: (backup) => controller.restoreSourceBackup(backup),
    importSettings: async (settings) => {
      const origin = gatewayOrigin(settings.gatewayOrigin);
      await controller.pause();
      await transport.disconnect();
      await transport.importSettingsOrigin(origin);
    },
    localArtifacts: () => controller.localArtifacts(),
    downloadArtifact: async (id) => {
      const { metadata, bytes } = await controller.artifacts.read(id);
      download(metadata.name, bytes, "application/octet-stream");
    },
    exportResources: () => transport.exportResources(),
    fetchHosts: async () =>
      (await store.get<string[]>("perch:fetch-approved-hosts")) ?? [
        "perchance.org",
        "user.uploads.dev",
      ],
    setFetchHosts: async (hosts) => {
      await store.set("perch:fetch-approved-hosts", hosts);
    },
  };
  manager = mountManager({ version: APP_VERSION, client });
  if (initializationError)
    manager.setStatus({
      connection: "blocked",
      reason:
        "Stored pairing incompatible. Export local data and recover pairing.",
    });
  GM_registerMenuCommand("Open Perch MCP", () => {
    void manager?.open();
  });
  // Browser bfcache/discard/closing stops admissions. No claim of cancelling already-dispatched effects.
  window.addEventListener("pagehide", () => {
    void controller.pause();
  });
}
if (document.readyState === "loading")
  document.addEventListener(
    "DOMContentLoaded",
    () => {
      void start().catch(() => {
        console.warn("Perch MCP", {
          code: "INITIALIZATION_FAILED",
          recovery:
            "Verify Violentmonkey content injection and reload. Native editing remains available.",
        });
      });
    },
    { once: true },
  );
else
  void start().catch(() => {
    console.warn("Perch MCP", {
      code: "INITIALIZATION_FAILED",
      recovery:
        "Verify Violentmonkey content injection and reload. Native editing remains available.",
    });
  });
