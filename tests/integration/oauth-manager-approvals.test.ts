import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { mountManager, type ManagerClient } from "../../apps/userscript/src/manager.js";

async function waitFor(predicate: () => boolean, ms = 8500): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(predicate(), "Timed out waiting for OAuth manager state");
}

test("pending ChatGPT OAuth request auto-appears even when Grant history fails, and approval is actionable", { timeout: 12000 }, async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://perchance.org/aleph-alpha#edit",
    pretendToBeVisual: true,
  });
  let approvals: Record<string, unknown>[] = [];
  let polls = 0, decisions = 0, grants = 0;
  const request: ManagerClient["request"] = async (method, path, body) => {
    if (method === "GET") {
      if (path.endsWith("/state")) return { version: "0.1.2", schemaVersion: 1, paired: true };
      if (path.endsWith("/workspaces"))
        return { items: [{ id: "workspace1", label: "aleph-alpha", agentId: "agent1", revision: 2 }], revision: 2 };
      if (path.endsWith("/agents"))
        return { items: [{ id: "agent1", label: "perchance-mcp-chatgpt-1", workspaceId: "workspace1", revision: 1 }], revision: 2 };
      if (path.endsWith("/approvals")) { polls++; return { items: [...approvals], revision: 3 }; }
      if (path.endsWith("/grants")) { grants++; throw new Error("synthetic Grants outage"); }
      throw new Error("Unexpected GET " + path);
    }
    if (method === "POST" && path.includes("/approvals/") && path.endsWith("/decision")) {
      const input = body as Record<string, unknown>;
      assert.equal(input.digest, "sha256-test-digest");
      assert.equal(input.decision, "approve");
      assert.equal(input.expectedRevision, 1);
      decisions++;
      approvals = approvals.map((a) => ({ ...a, state: "approved", revision: 2 }));
      return { ok: true };
    }
    throw new Error("Unexpected management action: " + method + " " + path);
  };
  const client: ManagerClient = {
    request,
    health: async () => ({ status: "ok" }),
    pair: async () => {},
    configuration: () => ({
      paired: true,
      origin: "https://perch.example.workers.dev",
      browserInstallationId: "fixture",
    }),
    currentIdentity: async () => ({
      generatorId: "42", slug: "aleph-alpha", draftId: "",
    }),
    copy: async () => {},
    download: () => {},
  };
  const manager = mountManager({ document: dom.window.document, version: "0.1.2", client, synthetic: true });
  const root = dom.window.document.querySelector("[data-perch-mcp-manager]")!.shadowRoot!;
  try {
    await manager.open("Agents");
    await waitFor(() => root.textContent?.includes("Grant history is temporarily unavailable") ?? false);
    assert.ok(root.textContent?.includes("Pending approvals"));
    const before = polls;
    approvals = [{
      id: "request1", code: "E491DC77", kind: "oauth", state: "pending", revision: 1,
      agentId: "agent1", workspaceId: "workspace1", clientId: "https://chatgpt.com/oauth/client.json",
      redirectUri: "https://chatgpt.com/connector_platform_oauth_redirect",
      scope: ["mcp"], expiresAt: Date.now() + 120000,
      digest: "sha256-test-digest",
    }];
    await waitFor(() => root.textContent?.includes("E491DC77") ?? false);
    assert.ok(polls > before, "polling updates without manual Refresh");
    assert.ok(root.textContent?.includes("https://chatgpt.com/oauth/client.json"));
    const approve = [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Approve exact request");
    assert.ok(approve);
    approve.click();
    await waitFor(() => decisions === 1);
    await waitFor(() => !(root.textContent?.includes("E491DC77") ?? false));
    assert.ok(grants >= 1);
  } finally {
    manager.destroy();
    dom.window.close();
  }
});
