import assert from "node:assert/strict";
import test from "node:test";
import { reconnectCandidate } from "../../apps/userscript/src/autoconnect.js";

const identity = {
  generatorId: "6b085395dda8641ac074535f",
  slug: "aleph-alpha",
  draftId: "",
};
const browserInstallationId = "browser-fixture";
const workspace = {
  id: "workspace-fixture",
  label: "aleph-alpha",
  paused: false,
  binding: { ...identity, browserInstallationId },
};
test("automatic reconnection selects only the unique matching existing native Binding", () => {
  assert.equal(reconnectCandidate([workspace], identity, browserInstallationId), workspace);
  assert.equal(reconnectCandidate([], identity, browserInstallationId), null);
  assert.equal(reconnectCandidate({}, identity, browserInstallationId), null);
  assert.equal(reconnectCandidate([workspace], identity, ""), null);
  assert.equal(reconnectCandidate([workspace, { ...workspace, id: "duplicate" }], identity, browserInstallationId), null,
    "ambiguous duplicate bindings must fail closed");
});
test("automatic reconnection never infers authority from a slug, wrong draft, or another browser installation", () => {
  for (const modified of [
    { generatorId: "other-id" },
    { slug: "other-generator" },
    { draftId: "other-draft" },
    { browserInstallationId: "other-browser" },
  ]) {
    assert.equal(
      reconnectCandidate([{ ...workspace, binding: { ...workspace.binding, ...modified } }], identity, browserInstallationId),
      null,
    );
  }
  assert.equal(reconnectCandidate([{ ...workspace, paused: true }], identity, browserInstallationId), null);
  assert.equal(reconnectCandidate([{ ...workspace, binding: null }], identity, browserInstallationId), null);
});
