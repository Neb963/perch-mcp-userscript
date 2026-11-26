---
name: upload-plugin
description: Perch MCP original upload-plugin development reference; current public-source review and operational guidance.
---

# File hosting
Source https://perchance.org/upload-plugin and https://perchance.org/upload . Import uploadPlugin = {import:upload-plugin}. Verify current public source for callable upload signature and result URL/error/deletion semantics before coding. Uploaded files hosted publicly (user.uploads.dev); never upload private keys, state backups or sensitive scratch without explicit authorization. Native srcState files are different: staged bytes become saved manifest only after native Save. Standalone upload may require native verification, support chunking/expiry and deduplicate bytes; verify length/digest. Retain deletion capability privately, do not delete shared asset merely because src path removed. Editable text files and temporary uploads have distinct limits; editable names generally lowercase alphanumeric/hyphen, _ may be server-write-only. Server job tickets enforce authorization. Do not hardcode historical daily quotas; surface actual provider errors. Test empty/binary bytes, quota/type rejection, aborted and uncertain upload, no automated CAPTCHA bypass.

## Exact current public upload behavior
The public callable accepts text or a Blob and optional `{expires}` using an absolute millisecond timestamp. It resolves an object with url, error, size and deletionUrl; an upload failure can resolve rather than reject. Check `error` and validate returned media bytes, host and length before success. A string-like url wrapper is still public data; coerce to a primitive string at a validated boundary.

Expiration guarantees availability until at least the requested time; it is not a scheduled deletion promise. Temporary retention can change quota cost, but never hardcode the historical multipliers as guaranteed capacity. Returned deletionUrl is a destructive capability. Retain it only in isolated private storage, never source, routine logs, resource exports or model-visible results. Public docs currently describe deletion within three days; inability to delete later is an operational risk.

| Operation | Current contract / control |
|---|---|
| upload(text or Blob, {expires?}) | Public immutable asset; confirm explicit publication intent |
| upload.createTicket({bytes,expires?}) | One server upload, current documented maximum16MiB; consume within about two minutes |
| upload.editable.get(name,{v?,binary?}) | Current or sequence-qualified content; missing => null; binary => ArrayBuffer |
| upload.editable.set(name,data,opts) | Public editable file; editKey remains private; inspect the current documented options before use |
| upload.editable.createTicket({bytes}) | One server `_` file write, current maximum5MiB |
| `_name` editable file | Page reads; server writes; do not attempt browser-set bypass |

Editable names use lowercase letters, digits and hyphens, with an initial underscore reserved for server writes. Version strings returned by sequence-aware server writes must be passed back unchanged; version_unavailable means retry a read after a delay or explicitly accept the current unqualified copy. In unsaved preview, `_` file reads may resolve the emulator's tab-local copy; this is not production state.

## Correct effect handling
Take an immutable snapshot of input bytes before dispatch. Record operation intent before an upload, preserve the returned URL privately until readback, and compare exact bytes/digest where available. A request timeout may occur after storage committed; do not reupload blindly. Removing a src path or changing an editor file does not authorize deleting a standalone uploaded asset shared elsewhere. Agent-visible artifacts stay authenticated/local unless public upload permission is explicit.

Test empty text, Unicode, invalid Blob/type, binary bytes, quota error returned in a fulfilled Promise, native verification challenge, interrupted upload, detached embed recovery, unexpected final host, wrong byte length and expiry boundaries. Do not automate CAPTCHA or upload private state backups merely because the plugin accepts arbitrary bytes.

## Provenance and verification status
Reviewed 2026-11-26 against the public plugin source and documentation URLs in this skill; exact retrieval hashes and access limitations are in documentation/public-source-review.md. This is independently authored guidance, not redistributed upstream source. Public-source review establishes API facts; live provider output, saved metadata and Firefox behavior require their own acceptance evidence.
