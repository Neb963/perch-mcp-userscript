---
name: super-fetch-plugin
description: Perch MCP original super-fetch-plugin development reference; expand against current public documentation.
---

# Runtime cross-origin fetch
Source https://perchance.org/super-fetch-plugin . Import superFetch = {import:super-fetch-plugin}; root.superFetch(url,options) is fetch-like via provider proxy, returns Response. Example await root.superFetch("https://example.com/data.json").then(r=>{if(!r.ok)throw Error("fetch failed");return r.json()}). Use for user-driven runtime public fetches, not our gateway privileged networking or arbitrary private addresses. Proxy quotas, permitted URLs and timeouts are provider-defined; no credential forwarding, validate destination and response, bound sizes, parse untrusted data safely. Development asset download uses MCP fetch_url with separate authorization and exact bytes. Never treat proxy as access-control bypass.
