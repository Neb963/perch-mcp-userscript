# Primary browser integration — Firefox + Violentmonkey

Owner decision supersedes earlier manager choice. Use current supported Violentmonkey and record exact Firefox, manager and script versions in P01. Pin @violentmonkey/types if needed; no manager-specific runtime library necessary.

## Implementation contract
- One userscript with metadata at byte zero, @match https://perchance.org/* and narrowly scoped preview subdomain matching as verified; exclude ai-agent, uploader and unrelated application frames unless an explicit adapter requires one. Do not set @noframes if preview role requires injection. @run-at document-start for lifecycle detection, wait for actual native readiness.
- Prefer @inject-into content for privileged controller. GM_info.injectInto must be verified. In Firefox content context, test wrappedJSObject / cloneInto for narrow native object calls; clone only validated primitive data, never export a privileged callback or expose a generic RPC. Native page methods may be adversarial/changed; use fixed method names and strict return validation. If impossible without unsafe privileges, report unsupported and investigate a narrower native bridge. Never disable CSP.
- Explicit grants for GM_getValue, GM_setValue, GM_deleteValue, GM_listValues, GM_addValueChangeListener, GM_removeValueChangeListener, GM_xmlhttpRequest, GM_registerMenuCommand, GM_setClipboard, and download only if needed. No GM_cookie, GM_mcp, @grant none, @unwrap or remote @require. Verify actual least grants in built artifact. No use of GM storage sync for secrets; shared script storage not per-tab security boundary.
- Configured gateway origin is operator-approved exact HTTPS origin, no caller-supplied URL. Metadata @connect must cover workers.dev and permitted Perchance resource hosts, or a user-approved custom host; prefer explicit allowlist. Do not silently request all-host access. GM_xmlhttpRequest with anonymous:true, fixed Authorization header, strict timeouts and response validation; prevent credential transmission on cross-origin redirects. If VM cannot guarantee safe redirect behavior for authenticated calls, use direct CORS HTTPS where supported or fail closed. Verify actual redirect behavior, cookie omission and final URL in P01/P02.
- WSS from isolated context first if available, otherwise privileged HTTPS fallback. WebSocket has no arbitrary request headers; single-use ticket and first-message proof as designed. No raw token URL, no page storage. Test CSP, background tab throttling, bfcache, discarded tab, duplicate tab, frame navigation, value-change propagation, storage capacity and credential isolation. A preview frame must never load privileged credentials even when code shares a metadata grant.
- New built-in VM AI Agent Access/GM_mcp (since 2.50.1) is not our architecture: its documented connection uses a local client/bridge and grants tab access through VM settings. Do not use it in production or introduce it as a required dependency. Optional future test adapter only with separate approval.

## Primary references
https://violentmonkey.github.io/api/metadata-block/
https://violentmonkey.github.io/api/gm/
https://violentmonkey.github.io/posts/inject-into-context/
https://violentmonkey.github.io/api/matching/
https://violentmonkey.github.io/guide/ai-agent-access/
https://violentmonkey.github.io/types/
https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Sharing_objects_with_page_scripts

These describe supported APIs, not proof of successful integration with Perchance. P01 is the proof gate.
## 0.2.0 notification candidate

The bundled top-frame controller constructs WebSocket in the isolated userscript context, with a scoped single-use ticket offered as a subprotocol. It never puts credentials in URLs, DOM, page storage or page callbacks. No grants, CSP relaxation or local bridge were added. Healthy push sleeps until availability/heartbeat reconciliation; failure safely uses the existing authenticated HTTPS transport. Worker flag PUSH_NOTIFICATIONS_ENABLED is opt-in; no new UI enable button exists. Real Firefox/Violentmonkey content-world/CSP/background behavior and physical Cloudflare hibernation remain DEFERRED_LIVE. Synthetic bundled-script, dropped wakeup, reconnection, stale generation and permission fixtures are offline evidence only.
