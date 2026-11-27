# OWNER-03 preview pixel capture

The v2 catalog includes capture_page_image and requires CAPTURE_PREVIEW and PREVIEW_CONTROL. This implementation returns UNSUPPORTED_INTERFACE without opening a picker or transferring an image. Synthetic fixtures verify that path. They cannot establish native pixels or client rendering.

| Interface | Evidence and consequence |
|---|---|
| Violentmonkey GM APIs | The documented privileged surface contains storage, requests and script interaction. It does not expose a tab-pixel API. [Violentmonkey API reference](https://violentmonkey.github.io/api/gm/) |
| Firefox WebExtensions capture | Tab capture belongs to the extension tabs API and requires extension permissions. The installed userscript has no such capability. [Mozilla WebExtensions reference](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/captureVisibleTab) |
| Firefox display capture | The API requires transient operator activation and surface selection. The selected display surface type alone cannot prove the current bound iframe, epoch, revision and preview-only crop. [Mozilla Screen Capture reference](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia) |

The minimum viable operator-assisted implementation requires a supported source of actual current preview pixels plus positive verification of surface, crop, Binding, preview epoch and revision. If that proof becomes available, use a one-shot consent action, stop all tracks on every exit, and qualify MIME, digest, dimensions and standard image rendering through the existing scoped transfer. A companion extension requires separate operator authorization. OWNER-03 remains open.
