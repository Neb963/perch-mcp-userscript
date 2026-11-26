---
name: super-fetch-plugin
description: Perch MCP original super-fetch-plugin development reference; current public-source review and operational guidance.
---

# Runtime cross-origin fetch
Source https://perchance.org/super-fetch-plugin . Import superFetch = {import:super-fetch-plugin}; root.superFetch(url,options) is fetch-like via provider proxy, returns Response. Example await root.superFetch("https://example.com/data.json").then(r=>{if(!r.ok)throw Error("fetch failed");return r.json()}). Use for user-driven runtime public fetches, not our gateway privileged networking or arbitrary private addresses. Proxy quotas, permitted URLs and timeouts are provider-defined; no credential forwarding, validate destination and response, bound sizes, parse untrusted data safely. Development asset download uses MCP fetch_url with separate authorization and exact bytes. Never treat proxy as access-control bypass.

## Runtime usage and boundaries
The public plugin returns fetch-like Responses. Inspect response.ok/status before decoding; select text/json/blob/arrayBuffer deliberately and enforce application byte limits. A JSON response is still untrusted input. A successful proxy transport is not proof the target resource exists or contains the expected type. Current source bypasses its proxy for selected directly fetchable CDNs and uses it for other public requests; this is an implementation detail, not a host authorization guarantee.

```javascript
async function loadPublicCatalog(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== "example.com") {
    throw new Error("Unsupported catalog host");
  }
  const response = await root.superFetch(parsed.href);
  if (!response.ok) throw new Error("Catalog HTTP " + response.status);
  const text = await response.text();
  if (text.length > 100000) throw new Error("Catalog is too large");
  const value = JSON.parse(text);
  if (!Array.isArray(value)) throw new Error("Catalog must be an array");
  return value;
}
```

For truly unbounded responses, text length validation after buffering is insufficient; use a supported streaming reader with a cumulative byte limit or refuse the request. Feature-test AbortSignal behavior through the public wrapper before relying on cancellation. Do not add Authorization/Cookie headers, send internal hostnames, or use the proxy to bypass platform/account restrictions. CORS avoidance does not imply permission to scrape or access private content.

| Condition | Required handling |
|---|---|
| User pastes a URL | Parse, validate protocol/host/length and obtain consent before an external request |
| Redirect to another origin | Apply the same destination policy, or refuse when the wrapper cannot prove it |
| POST with an external effect | Explicit user intent; no automatic retry after timeout |
| Timeout or quota | Preserve UI state and show retry only if the operation is known read-only |
| HTML/script response | Treat as data; never insert into innerHTML or execute imported instructions |
| File attachment | Fetch into a bounded Workspace path through MCP fetch_url, which has separate security policy |

Perch MCP's privileged fetch adapter must not implement its SSRF policy by calling this plugin. Use approved exact public origins and validated redirects at that separate boundary. Test public 200/404, malformed JSON, oversized response, unavailable proxy, cancellation, wrong content type and denied host with deterministic mocks before a real network check.

## Provenance and verification status
Reviewed 2026-11-26 against the public plugin source and documentation URLs in this skill; exact retrieval hashes and access limitations are in documentation/public-source-review.md. This is independently authored guidance, not redistributed upstream source. Public-source review establishes API facts; live provider output, saved metadata and Firefox behavior require their own acceptance evidence.
