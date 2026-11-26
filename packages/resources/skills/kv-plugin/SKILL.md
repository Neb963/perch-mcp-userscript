---
name: kv-plugin
description: Perch MCP original kv-plugin development reference; expand against current public documentation.
---

# Persistent browser key/value
Source https://perchance.org/kv-plugin . Import kv = {import:kv-plugin}. IndexedDB-backed generator/device-local storage, asynchronous structured-cloneable values. root.kv.<folder>.get(key), set(key,value), delete(key), setMany([[key,value]]), getMany(keys), deleteMany(keys), entries(), keys(), values(). Missing get yields undefined. Use await root.kv.game.update("score",v=>(v??0)+1) for read-modify-write transaction, not separate get/set with await race. Handle quota, missing values, corrupt schema, device reset and migrations. Data not cross-user server storage, not automatically private from generator code. Use browser storage for simple flags only if suitable. Verify current plugin source for exact transaction limitations. Test reload and overlapping updates.
