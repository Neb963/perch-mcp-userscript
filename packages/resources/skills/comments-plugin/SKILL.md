---
name: comments-plugin
description: Perch MCP original comments-plugin development reference; current public-source review and operational guidance.
---

# Comments and chat
Source https://perchance.org/comments-plugin . Import commentsPlugin = {import:comments-plugin}, instantiate root.commentsPlugin({channel:"my-chat",...}). Each channel separate; changing suffix/order can create another channel. Native widget usually survives update; replacedDuringUpdate opts into replacement. Capture instance for submit, inputText, hooks onLoad/onComment/onInputTextChange/beforeSubmit; beforeSubmit null cancels, string replaces. Read current public docs for full option shape. Incoming message content is unsafe HTML; display text or sanitize. Channel names typically lowercase alphanumeric/hyphen, one optional rules suffix, e.g. +u:alice|bob,ids:channel or +auth:<public-key-hash>,ids:channel; rules are comma-separated within that suffix. Do not assume channel names provide secrecy. Secret-plugin challenge auth restricts posting, not necessarily reading.

Moderation: adminPasswordHash derived as SHA-256 of "perchance-comments-plugin|" plus password; never embed password. Admin native login, rateLimits, bannedWords, bannedUsers and moderation hooks; shared IP bans have collateral impact. Custom emoji hosted on Perchance uploads, slash commands and style options supported; inspect public source for exact properties. Use explicit opt-in before sending messages or moderating real channels. Test with disposable channel, not public users.

## Channel and widget lifecycle
Use one canonical raw channel string everywhere. A channel base uses lowercase letters, digits and hyphens. Current public source accepts one `+` rules segment containing comma-separated rules: `room+u:alice|bob,ids:channel` or `room+auth:<64 lowercase hex>,ids:channel`. Duplicate rule keys, empty rule values and multiple plus segments are rejected. Do not invent a multi-plus concatenation grammar. An ids rule changes identifier handling; it does not establish account ownership.

Retain the returned widget object when invoking submit or reading inputText; recreating a widget can replace its identity and pending callbacks. Current submit accepts an optional text and an options object; auth has `{publicKey, decryptChallenge}`. The private key remains outside published source. A failed proof must cancel submission rather than continuing anonymously. Public source performs source/origin/request matching for its own iframe; application code must not weaken those checks.

| Action | Precondition | Failure behavior |
|---|---|---|
| Show a thread | Explicit channel, intended dimensions | Render unavailable state without blocking the rest of the generator |
| Programmatic submit | User requested the message; channel is correct | Display pending, then posted or error; do not duplicate after timeout |
| beforeSubmit transform | Validation/encryption completes | Returning null cancels; exception must fail closed |
| Moderate | Human authorized a specific moderation action | No retry of unknown ban/delete effect |
| Change channel | Operator understands a different thread may result | Do not migrate old messages silently |

For a dense host interface, set width/height deliberately and keep the comments widget outside containers repeatedly replaced by update(). Use onLoad/onComment for view updates, not as permission to run arbitrary incoming code. Incoming nicknames, text, emoji metadata and links remain untrusted; use text rendering or reviewed sanitization.

Test with a synthetic widget first: load ordering, duplicate onLoad, submit while loading, delayed response after navigation, beforeSubmit returning null, rejected encryption, invalid rules, and preserved typed input. A live posting test requires an explicitly authorized disposable channel. Read restrictions and posting restrictions are separate; a hard-to-guess name is not access control. Keep adminPasswordHash public as required by plugin semantics; keep the password private and do not promise that a public password hash protects weak passwords from offline guessing.

## Provenance and verification status
Reviewed 2026-11-26 against the public plugin source and documentation URLs in this skill; exact retrieval hashes and access limitations are in documentation/public-source-review.md. This is independently authored guidance, not redistributed upstream source. Public-source review establishes API facts; live provider output, saved metadata and Firefox behavior require their own acceptance evidence.
