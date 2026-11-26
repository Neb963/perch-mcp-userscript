---
name: server-plugin
description: Perch MCP original server-plugin development reference; current public-source review and operational guidance.
---

# Perchance server-side generators
Source https://perchance.org/server-plugin and https://perchance.org/doc-server-plugin . Import createServerSocket = {import:server-plugin}; browser uses socket-like messaging, native server code in <script type="text/x-server-plugin">. Server source is publicly readable: never put credentials or secrets in it. Read current official documentation and fetch_generator("server-plugin") before choosing exact API/limits.

Server handlers are synchronous/event-driven; no ordinary timers. Maintain bounded state, explicit input validation and authorization. Browser connection messages and RPC arguments are attacker-controlled. Use server authority for permissions, scores, inventory and moderation; do not trust browser values. proveDev()/conn.isDev are documented owner/developer mechanisms, not permission to impersonate. Treat connection group/network metadata as signals, not identity. Reconnect and duplicate delivery must be handled. Keep per-user queues bounded; validate message and state sizes. Historical durable state allocation is about 50 MiB, subject to current provider limits. Store schema version, deterministic migrations, and explicit recovery for malformed data. Use server-supported files/storage for larger payloads; don't assume arbitrary filesystem or network. Unsaved preview may run an isolated emulator; never assume emulator state is production state.

Before editing existing server code: determine if production durable state exists, request authorized download_server_plugin_state and retain digest/backup; if unavailable, stop risky production edits and explain. Test schema compatibility in emulator/disposable fixture. Production restore replaces live data and can disconnect clients; require exact approved digest, previous backup, readback and operation reconciliation. Never automatically retry an ambiguous restore. A no-argument upload_server_plugin_state is reconciliation only. Emulator seeding is distinct and opt-in. Do not expose production bytes through public src or upload.

AI text/image/upload/editable-file jobs require documented browser-issued tickets and server-side enqueue. Ticket scope/expiry and exact parameters matter. Validate results, deduplicate at-least-once deliveries using pending job IDs, cap retry and handle timeout. Avoid blocking handlers. With no timers, evaluate deadlines on events or a bounded client tick. Treat generated text as untrusted; strict parse or reject. Public server code cannot contain private moderation prompts or secrets. For editable files use documented sequencing and quota rules; _ prefix may denote server-write-only. Verify all exact methods, payloads, limits and lifecycle in public reference and disposable tests; this seed is not a replacement for the full public server documentation.

## Current public browser contract
The reviewed factory creates socket-compatible connections and supplies `opened`, `closed`, `rpc` and `proveDev()` helpers. Wait for opened before sending, bound pending work, and treat closed as a separate terminal signal. RPC methods accept exactly one payload (text or supported bytes) and return a Promise. Wrong framing, remote error and disconnection are distinct failures. A socket close after an external mutation is not evidence that the mutation never happened.

`await socket.proveDev()` asks the native environment to prove current edit permission; it does not grant permission merely because a client claims to be the owner. Use `conn.isDev` only after the server's documented proof handling. Never create a homemade account session bridge or embed native credentials.

The factory also currently exposes these explicitly documented emulator testing aids:

| Public helper | Outcome | Boundary |
|---|---|---|
| getEmulatorState() | Copy of current emulator state bytes | Unsaved editor only |
| setEmulatorState(bytes) | Replace emulator state and restart sockets | Destructive to this tab's emulator state; snapshot first |
| setEmulatorState(js) | Run initialization code after server top level | Only with explicit preview execution permission; untrusted code |
| getEmulatorFiles() | Text/binary/missing file map with sequence data | Not production file inventory |
| setEmulatorFile(name,value) | Set local text/binary file or missing marker | Local emulator only |

A state seed clears local emulator files and closes emulated sockets with restart status 1012. The public implementation rejects these helpers on saved production connections and explicitly identifies no equivalent production aid. Do not label emulator export as production backup. Do not inject code into production merely to manufacture a backup endpoint. For existing production data, require a provider-supported or already owner-designed consistent backup interface; unresolved support blocks production-state parity.

## Application protocol design
Use a versioned message envelope, validate types and byte counts, authorize each command on the server, and bound subscriptions/queues. Jobs may deliver results more than once: persist a request ID and terminal state before sending replies. A sequence/version is separate from a random request ID. When client input updates a durable record, compare its base version and reject stale writes. For reconnect, reauthenticate and resubscribe explicitly; do not replay ambiguous purchases, uploads or restores.

Server jobs use browser-issued one-use tickets: text, image, upload and editable-file tickets have different limits and expiration. Build the exact supported payload from current docs, not from a guessed common API. Editable `_` files written by the server can be read through upload.editable; sequence-aware reads avoid an older CDN copy. Arbitrary code, filesystem, timers and network are not presumed available in server handlers.

Test two clients writing one record, invalid messages, disconnect between commit/reply, duplicate job completion, exhausted tickets, incompatible state versions, emulator restart and corrupt backup rejection. Production restore requires a previous consistent backup, exact approved digest, fresh identity and independent verification; unknown results stay in reconciliation.

## Provenance and verification status
Reviewed 2026-11-26 against the public plugin source and documentation URLs in this skill; exact retrieval hashes and access limitations are in documentation/public-source-review.md. This is independently authored guidance, not redistributed upstream source. Public-source review establishes API facts; live provider output, saved metadata and Firefox behavior require their own acceptance evidence.
