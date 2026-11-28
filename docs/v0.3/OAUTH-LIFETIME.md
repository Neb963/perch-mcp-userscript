# OAuth lifetime and revocation contract — v0.3 remediation

## Authority

**Authorization is perpetual until explicit revocation.** Registry v2 Grant `expiresAt:null`, OAuth refresh authorization, and dynamic client registration do not expire due to inactivity, reconnect, suspension, Workspace detachment or temporary provider failure. Access tokens remain finite. Revocation is checked against the canonical Registry for effects and refresh; no token has irrevocable authority.

## Offline verified facts

- Pinned Cloudflare OAuth SDK 1.4.0 issued, refreshed and revoked candidate access tokens from 15 minutes through 10 years in local Miniflare with canonical Registry grants, rotating refresh tokens and KV metadata.
- Chromium JavaScript timers accept a 32-bit-millisecond maximum of 2,147,483,647 ms. Our isolated Chromium test observed that a `setTimeout` request of 2,147,483,648 ms fired near-immediately. This matters if an external OAuth client naively schedules `setTimeout(refresh,expires_in*1000)`.
- 10 years is 315,360,000 seconds = 315,360,000,000 ms; it exceeds that timer range by roughly two orders of magnitude. Although the SDK accepts that lifetime, **actual client interoperability has NOT been verified**.
- 24 days = 2,073,600 seconds = 2,073,600,000 ms. It fits under the timer threshold with a margin of 73,883,647 ms (~20.5 h). This is the maximum whole-day default with one-day scheduling margin.

## Decision

- `persistentAccessTokenTTL(undefined)` returns `24*86400` on v2, not 10 years.
- The `OAUTH_ACCESS_TOKEN_TTL_SECONDS` override accepts any tested range 60 s through 10 years. Values above 24 days are **explicit operator experiments**, not default production qualification. Real ChatGPT Connector and any other client must prove no refresh loop or token-persistence regression before enabling an override.
- Permanent authorization does **not** depend on token lifetime: a client that retains a refresh credential may renew indefinitely until revocation; suspension rejects execution while preserving refresh capability.
- Both issuance and refresh have bounded retries and the gateway never assumes quota is available from local metrics alone. Quota failure must not revoke consent.

## Acceptance

1. Actual pinned SDK miniflare tests for 900, 1800, 3600, 7200, 86400, 604800, 2592000, 2073600, 31536000 and 315360000 seconds.
2. Default and timer threshold unit test, including 25 days > 2^31-1 ms.
3. OWNER-02: real ChatGPT client refresh and restart across a 24-day token; no early timer overflow or refresh storm, followed by owner-driven consideration of longer overrides.
4. OWNER-04: real Cloudflare KV metering, revocation propagation, and unexpected client retries.

**Do not interpret a long bearer token as unrevokeable.** A stolen token remains dangerous until the canonical Registry denies it, and the actual client might cache independently. Keep permission ceilings and per-effect checks.
