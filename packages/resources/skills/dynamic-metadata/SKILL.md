---
name: dynamic-metadata
description: Perch MCP original dynamic-metadata development reference; current public-source review and operational guidance.
---

# Dynamic metadata
Public docs/source: https://perchance.org/tutorial and https://perchance.org/ai-character-chat . $meta.dynamic(inputs) returns JSON object with optional title,description,image; static fallback stays. Use inputs.urlParams; validate lengths/characters, encode URL components. Keep helpers and mapping inside function: provider extracts it into isolated sandbox, no root/window/document/browser storage/outer imports. Synchronous or async allowed; short bounded fetch, catch failures; deterministic by input since responses cached. Keep tags/header static. Historical bounds title 500 chars, description 3000, image URL 500; reverify. Test root.$meta.dynamic({urlParams:{...}}) in preview then actual saved GET /api/getDynamicMetaData?__generatorName=<slug>&...; browser success alone is not server proof. Use missing/invalid params, unavailable remote data and fallback tests. Save only with permission.

## Pure metadata function contract
Treat dynamic metadata as a server-computed projection of URL inputs. Keep source-independent helpers inside the function, validate values before accessing a lookup table, use a stable fallback, and return only documented fields. The preview's DOM and browser storage are unavailable to an extracted function. Do not assume imported modules, closure variables or authenticated browser cookies exist there.

```javascript
async function dynamic(inputs) {
  const value = String(inputs?.urlParams?.item ?? "");
  if (!/^[a-z0-9-]{1,60}$/.test(value)) {
    return { title: "Catalog", description: "Choose an item." };
  }
  const names = { otter: "Otter", raven: "Raven" };
  const name = names[value];
  return name
    ? { title: name + " — Catalog", description: "Details for " + name + "." }
    : { title: "Catalog", description: "Item unavailable." };
}
```

Adapt this function body to `$meta.dynamic(inputs)` using PJS function syntax; it is not a separate browser global registration API. Use fixed trusted image origins and URL construction; validate identifiers rather than concatenating arbitrary URLs from a query. Avoid secrets, user identifiers or private state in metadata, which is public and cached. Fetches need an explicit timeout/fallback and bounded response. Cache keys and cache age are provider behavior; time-dependent or personalized output cannot be assumed fresh.

| Test | Expected result |
|---|---|
| No parameter | Static or explicit fallback metadata |
| Known identifier | Correct title/description/image pair |
| Unknown identifier | Bounded public fallback, no unhandled rejection |
| Oversized, repeated or malformed parameter | Validation rejects; output limits remain satisfied |
| Remote service unavailable | Fallback rather than missing page metadata |
| Preview success, then saved endpoint | Compare actual saved `/api/getDynamicMetaData?__generatorName=<slug>&...` output |

Current public tutorial template was retrieved for core language review; the exact dynamic extraction implementation and historical 500/3000/500 field bounds were not independently exercised. Preserve those as conservative historical constraints until a disposable saved-generator test establishes current behavior. Do not claim browser-only validation proves social crawler behavior, cached image fetch, or server execution.

## Provenance and verification status
Reviewed 2026-11-26 against the public plugin source and documentation URLs in this skill; exact retrieval hashes and access limitations are in documentation/public-source-review.md. This is independently authored guidance, not redistributed upstream source. Public-source review establishes API facts; live provider output, saved metadata and Firefox behavior require their own acceptance evidence.
