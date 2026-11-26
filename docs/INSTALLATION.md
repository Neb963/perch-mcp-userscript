# Candidate installation

This package is a verification candidate. It is not a full-parity release. Read RELEASE_VERIFICATION.md and the per-capability implementation records before using a real generator. No production deployment or provider mutation was performed to prepare it.

## Cloudflare dashboard path

1. Use a reviewed immutable commit of this repository. In Workers & Pages, import the Git repository as a Worker project. Set build command `npm ci && npm run build`, deploy command `npx wrangler deploy --config apps/gateway/wrangler.jsonc`, and project root `/`. Disable automatic deployment of unrelated development branches.
2. The Wrangler configuration declares SQLite Durable Object classes `Registry` and `Workspace`, migration `v1`, and an automatically provisioned `OAUTH_KV` binding. It includes a required `BOOTSTRAP_SECRET` prompt. Generate at least 32 random bytes in a password manager and encode as at least 43 base64url characters. There is no default secret.
3. Keep `PROVIDER_WRITES_ENABLED=false` and paid media disabled during initial qualification. The dashboard deploy/migration/provisioning path has not been exercised against a clean real account. If the platform does not prompt/provision as expected, follow the official dashboard instructions linked in GATEWAY_IMPLEMENTATION.md; do not invent namespace IDs.
4. Open the resulting HTTPS Worker `/health`. Before pairing, it exposes version/schema/setup information only. Use the exact Worker origin, without `/mcp`, credentials, query parameters or fragments.
5. Install `perch-mcp.user.js` in Firefox with Violentmonkey. The identical `perch-mcp.user.txt` mirror supports manual import. The script bundles the computation engine and references; no external resource archive or runtime module download is required. No separate extension, daemon or browser bridge is installed.
6. Open an editor and choose Perch MCP → Settings. Check the gateway, then pair with the exact origin and enter the bootstrap secret through the native browser dialog. Credentials are never entered into page-DOM fields. Pairing consumes the secret once. The management credential and separate execution credential remain in Violentmonkey isolated storage. If the response is lost, use credential recovery; do not assume pairing did not happen.
7. Check Library: eleven domain skills, a workflow, instructions and provenance documentation are initialized without an import. Gateway availability does not affect ordinary editor use.

The userscript uses isolated-context HTTPS `fetch` with `credentials:omit` and `redirect:error`. The gateway permits the exact editor Origin. An unsupported Firefox/Violentmonkey/CSP combination must fail without retrying through unsafe authenticated redirects. There is no all-host GM request permission or CSP modification.

## Released deployment package fallback

`perch-mcp-cloudflare.zip` contains a bundled `worker.mjs`, Wrangler configuration and example environment file. For a dashboard Git import, extract it to a repository and retain the configuration and migrations; a single pasted JavaScript file cannot declare the Durable Object migration or KV binding. If a dashboard-only migration is unavailable, the explicit deployment-only fallback is:

```sh
npm install
npx wrangler deploy
```

This command is not a runtime service. Deployment requires the Operator's Cloudflare account and authorization; no credentials are supplied by this package.

## Development verification

```sh
npm ci
npm run typecheck
npm test
npm run build
npx wrangler deploy --dry-run --config apps/gateway/wrangler.jsonc
```

Local tests use original synthetic fixtures and local workerd. They do not prove a real Firefox installation, Cloudflare account, provider state or web-client consent flow. The isolated compute Worker test is an actual separate thread with host fetch disabled; preview format tests simulate current public native messages.

## Optional paid music

Music defaults to disabled. For a disposable authorized test, the Operator must configure `ELEVENLABS_API_KEY` as a Worker secret and `PAID_MEDIA_ENABLED=true` explicitly, inspect provider billing, and authorize `MEDIA` and `WRITE_SOURCE` for the Workspace. Do not place this credential in a generator, Resource, MCP URL or browser export. Current provider controls, cost and fidelity limits are documented in PARITY_IMPLEMENTATION.md. No paid call has been made in this implementation session. A native Helper subscription does not supply API authorization.

The fixed music route only executes the exact admitted running operation. It persists paid intent before dispatch, never retries generation automatically, validates MP3 framing, transfers bounded authenticated chunks, retains a local artifact, decodes audio in the browser, and commits to the exact requested source revision. A lost receipt or source conflict requires reconciliation; the generated asset must not be requested again merely to recover its bytes.
