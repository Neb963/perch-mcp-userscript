---
name: dynamic-metadata
description: Perch MCP original dynamic-metadata development reference; expand against current public documentation.
---

# Dynamic metadata
Public docs/source: https://perchance.org/tutorial and https://perchance.org/ai-character-chat . $meta.dynamic(inputs) returns JSON object with optional title,description,image; static fallback stays. Use inputs.urlParams; validate lengths/characters, encode URL components. Keep helpers and mapping inside function: provider extracts it into isolated sandbox, no root/window/document/browser storage/outer imports. Synchronous or async allowed; short bounded fetch, catch failures; deterministic by input since responses cached. Keep tags/header static. Historical bounds title 500 chars, description 3000, image URL 500; reverify. Test root.$meta.dynamic({urlParams:{...}}) in preview then actual saved GET /api/getDynamicMetaData?__generatorName=<slug>&...; browser success alone is not server proof. Use missing/invalid params, unavailable remote data and fallback tests. Save only with permission.
