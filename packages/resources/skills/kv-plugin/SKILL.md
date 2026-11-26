---
name: kv-plugin
description: Perch MCP original kv-plugin development reference; current public-source review and operational guidance.
---

# Persistent browser key/value
Source https://perchance.org/kv-plugin . Import kv = {import:kv-plugin}. IndexedDB-backed generator/device-local storage, asynchronous structured-cloneable values. root.kv.<folder>.get(key), set(key,value), delete(key), setMany([[key,value]]), getMany(keys), deleteMany(keys), entries(), keys(), values(). Missing get yields undefined. Use await root.kv.game.update("score",v=>(v??0)+1) for read-modify-write transaction, not separate get/set with await race. Handle quota, missing values, corrupt schema, device reset and migrations. Data not cross-user server storage, not automatically private from generator code. Use browser storage for simple flags only if suitable. Verify current plugin source for exact transaction limitations. Test reload and overlapping updates.

## Storage model and transaction boundaries
The current public source wraps idb-keyval 6.2.1 and exposes twelve methods per named store: get, has, getMany, entries, keys, values, set, setMany, update, delete, deleteMany and clear. Store names and plugin module identity participate in IndexedDB names. Changing the store name or replacing the plugin with a fork can make existing data appear missing; plan an explicit read/migrate/write path before renaming either.

The updater passed to update must synchronously return the complete new stored value. This is essential for objects:

```javascript
await root.kv.characters.update("bob", old => {
  const character = old ?? { hp: 100, inventory: [] };
  return { ...character, hp: Math.max(0, character.hp - 1) };
});
```

Do not return `character.hp--`: it returns a number and replaces the object. Do not use an async updater: IndexedDB transaction callbacks cannot keep the transaction open across arbitrary await boundaries, and a Promise is not the intended stored value. get followed by set is not an atomic increment. setMany batches writes within one store; it is not a cross-store transaction API.

| Requirement | Implementation |
|---|---|
| Schema evolution | Store a schema version; validate data at load; migrate a copy, then atomically replace the record |
| Multiple writers | Use update for one-record read/modify/write; choose one serialized owner for multi-record invariants |
| Missing key | Distinguish undefined from a valid zero, false, empty text or null |
| Recovery | Export user data before destructive migration; preserve unknown fields where possible |
| Quota rejection | Keep the current UI draft, show an actionable export/cleanup path, avoid infinite retries |
| Large enumeration | Bound data size; entries/keys/values load whole results, so do not use them on each keystroke |

Values use structured cloning. Do not store functions, DOM nodes or secrets intended to be protected from the generator's own JavaScript. This is per-browser, per-origin/partition storage; it does not synchronize another device and can be cleared by privacy settings or user action. Calling clear is destructive for that store and requires deliberate user intent.

Test overlapping increments, missing/corrupt records, object updates, reload, rejected quota, migration interruption and two tabs with conflicting edits. Verify application behavior when persistent storage is denied. The public documentation's large capacity examples describe possible browser allowance, not a reserved storage guarantee.

## Provenance and verification status
Reviewed 2026-11-26 against the public plugin source and documentation URLs in this skill; exact retrieval hashes and access limitations are in documentation/public-source-review.md. This is independently authored guidance, not redistributed upstream source. Public-source review establishes API facts; live provider output, saved metadata and Firefox behavior require their own acceptance evidence.
