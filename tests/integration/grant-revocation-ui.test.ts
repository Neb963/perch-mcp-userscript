import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { mountManager, type ManagerClient } from "../../apps/userscript/src/manager.js";

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!condition() && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 25));
  assert.ok(condition(), "Expected Grant UI transition did not occur");
}

function ui(uncertainPost = false, initiallyRevoked = false) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://perchance.org/aleph-alpha#edit",
    pretendToBeVisual: true,
  });
  let state = initiallyRevoked ? "revoked" : "active";
  let revision = initiallyRevoked ? 2 : 1;
  let postCount = 0;
  const grantId = "grant-fixture";
  const client: ManagerClient = {
    configuration: () => ({
      origin: "https://gateway.example.workers.dev", paired: true,
    }),
    request: async (method, path, body) => {
      if (method === "GET") {
        if (path.endsWith("/state")) return { schemaVersion: 1, paused: false, revision: 5 };
        if (path.endsWith("/workspaces")) return {
          items: [{ id: "workspace-fixture", label: "aleph-alpha", revision: 1 }], revision: 1,
        };
        if (path.endsWith("/agents")) return {
          items: [{ id: "agent-fixture", workspaceId: "workspace-fixture", label: "ChatGPT", revision: 1 }], revision: 1,
        };
        if (path.endsWith("/approvals")) return { items: [], revision: 1 };
        if (path.endsWith("/grants")) return {
          items: [{
            id: grantId, agentId: "agent-fixture", workspaceId: "workspace-fixture",
            clientId: "https://chatgpt.com/oauth/client.json", state, revision,
            expiresAt: Date.now() + 3600000,
          }], revision,
        };
        throw new Error("Unexpected GET: " + path);
      }
      if (method === "POST" && path.endsWith("/grants/" + grantId + "/revoke")) {
        assert.equal((body as Record<string, unknown>).expectedRevision, 1);
        postCount++;
        state = "revoked";
        revision = 2;
        if (uncertainPost)
          throw new Error("GATEWAY_UNAVAILABLE: POST response lost after commit");
        return { id: grantId, state, revision };
      }
      throw new Error("Unexpected management call: " + method + " " + path);
    },
    health: async () => ({ version: "0.1.5" }),
    pair: async () => {},
    currentIdentity: async () => ({ generatorId: "synthetic", slug: "aleph-alpha", draftId: "" }),
    copy: async () => {},
    download: () => {},
  };
  const manager = mountManager({
    document: dom.window.document, version: "0.1.5", client, synthetic: true,
  });
  const root = dom.window.document.querySelector("[data-perch-mcp-manager]")!.shadowRoot!;
  const click = (label: string) => {
    const target = [...root.querySelectorAll("button")].find((b) => b.textContent === label);
    assert.ok(target, "Missing button: " + label);
    target.click();
  };
  return {
    dom, manager, root, click, postCount: () => postCount,
    currentState: () => state,
  };
}
for (const uncertainPost of [false, true]) {
  test("Grant revoke requires explicit confirmation and verifies authoritative state" +
    (uncertainPost ? " even when POST response is lost" : ""), async () => {
      const h = ui(uncertainPost);
      try {
        await h.manager.open("Agents");
        await waitFor(() => h.root.textContent?.includes("Revoke Grant") ?? false);
        h.click("Revoke Grant");
        assert.equal(h.postCount(), 0, "first click never mutates");
        await waitFor(() => h.root.textContent?.includes("Confirm revoke") ?? false);
        h.click("Confirm revoke");
        await waitFor(() => h.currentState() === "revoked");
        await waitFor(() => h.root.textContent?.includes("Revoked — no further authorization") ?? false);
        assert.equal(h.postCount(), 1, "one POST only; uncertain results are reconciled by GET");
        assert.ok(![...h.root.querySelectorAll("button")].some((b) => b.textContent === "Revoke Grant"));
      } finally {
        h.manager.destroy();
        h.dom.window.close();
      }
    });
}
test("already-revoked Grant is visibly terminal and has no mutation control", async () => {
  const h = ui(false, true);
  try {
    await h.manager.open("Agents");
    await waitFor(() => h.root.textContent?.includes("Revoked — no further authorization") ?? false);
    assert.ok(![...h.root.querySelectorAll("button")].some((b) => b.textContent === "Revoke Grant"));
    assert.equal(h.postCount(), 0);
  } finally {
    h.manager.destroy();
    h.dom.window.close();
  }
});
