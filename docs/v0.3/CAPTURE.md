# OWNER-03 preview pixel capture

The v2 catalog includes capture_page_image and requires CAPTURE_PREVIEW and PREVIEW_CONTROL. This implementation returns UNSUPPORTED_INTERFACE without opening a picker or transferring an image. Synthetic fixtures verify that path. They cannot establish native pixels or client rendering.

| Interface | Evidence and consequence |
|---|---|
| Violentmonkey GM APIs | The documented privileged surface contains storage, requests and script interaction. It does not expose a tab-pixel API. [Violentmonkey API reference](https://violentmonkey.github.io/api/gm/) |
| Firefox WebExtensions capture | Tab capture belongs to the extension tabs API and requires extension permissions. The installed userscript has no such capability. [Mozilla WebExtensions reference](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/captureVisibleTab) |
| Firefox display capture | The API requires transient operator activation and surface selection. The selected display surface type alone cannot prove the current bound iframe, epoch, revision and preview-only crop. [Mozilla Screen Capture reference](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia) |

The minimum viable operator-assisted implementation requires a supported source of actual current preview pixels plus positive verification of surface, crop, Binding, preview epoch and revision. If that proof becomes available, use a one-shot consent action, stop all tracks on every exit, and qualify MIME, digest, dimensions and standard image rendering through the existing scoped transfer. A companion extension requires separate operator authorization. OWNER-03 remains open.

## Chromium Element Capture feasibility

Chromium desktop provides a candidate userscript-only compositor path. A trusted local click can request tab sharing and restrict one video track to a `RestrictionTarget`. Successful restriction binds emitted frames to the target subtree and excludes unrelated overlay content. A picker preference does not establish surface identity. Region Capture crops a rectangle and can include overlays. [Chrome Element Capture](https://developer.chrome.com/docs/web-platform/element-capture) · [Element Capture specification](https://screen-share.github.io/element-capture/)

An offline Chromium 158.0.8127.0 probe minted a RestrictionTarget for a synthetic cross-origin iframe under regular same-origin policy in an isolated content realm. A second probe minted a target inside the exact synthetic child document and received its browser-branded opaque token using origin, WindowProxy and caller nonce checks. The token survives structured clone and produces an empty object when JSON-serialized. No chooser opened, no stream or pixels were sampled, and no external requests were sent. Run the synthetic probe with `BROWSER_EXECUTABLE=/path/to/chromium PLAYWRIGHT_MODULE=/path/to/playwright-core node tests/offline-preview/capture-interface.mjs`.

The shipped top-level userscript's iframe element and WindowProxy can survive child navigation. Their identity does not select the child Document that rendered a captured frame. The native preview evaluate bridge JSON-serializes its results. A separate trusted pre-start path must mint a document-bound target and pass it through structured clone. A token supplied by untrusted generator JavaScript cannot establish which element it selected. No such trusted document path has qualified on the native preview.

The candidate implementation requires an authenticated one-shot document mint, current Binding and verified PreviewRevision before consent, successful browser restriction before any pixel sink, fresh capture authorization, one bounded frame, post-sample document verification, and immediate track teardown on success, denial, cancellation or timeout. A picker that resolves after cancellation must stop every returned track without sampling. The Firefox capability and OWNER-03 remain unresolved.
