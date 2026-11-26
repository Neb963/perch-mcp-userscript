# Manager implementation evidence

Implementation date: 2026-11-26. This document records T0/T1 evidence, not live Firefox or Cloudflare acceptance.

`apps/userscript/src/manager.ts` exports `mountManager(options)`. The controller supplies authenticated `ManagerClient` methods. The manager does not receive management, execution, OAuth or lease credentials. Controller requests must add a fresh idempotency key to each management mutation, validate fixed gateway origin and refuse credential redirects.

## Implemented interaction paths

| Area | Behavior |
|---|---|
| Setup | Exact HTTPS-origin validation; health/version check; one-time pairing; bootstrap field cleared before request; native identity probe; offline Settings remains available |
| Workspaces | Create with explicit default/development permissions; attach/rebind current editor; pause/resume; reconnect; detach; rename; exact permission editor; copy assigned endpoint |
| Agents | Create named assignment; exact encoded endpoint and connector instructions; rename; suspend/resume; pending OAuth/effect request digest, client, scope, redirect, expiry and approve/deny; separate Grant revocation |
| Library | List/filter/sort; new Resource; duplicate; enable/disable; delete; local draft persistence; editable main text/reference files/metadata; explicit revision publish; body/reference diff; inert text preview; history and restore as new revision; global/Workspace/Agent enable/disable assignment |
| Imports | ZIP selection, bounded input, server/local preview, exact entry sizes/actions/exclusions, explicit replace/skip/fork decisions, atomic gateway commit; no publication during preview |
| Activity | Operation IDs, Workspace, tool, phase, duration/error; explicit UNKNOWN recovery; allowlisted diagnostic export; private local attachment download when controller supports it |
| Settings | Secret-free settings export/import; separate source backup/restore adapter; local disconnect; global pause/resume; immediate document stop; execution limit/recovery explanation |
| Accessibility/layout | Scoped ShadowRoot; dialog focus trap, Escape/close and focus return; arrow/Home/End section navigation; labelled inputs and status; dialog overflow hidden with one main scroll area; textarea grows with content; no native editor changes |

The ShadowRoot is open for deterministic inspection. It is a style boundary, not an authentication or credential boundary. Manager DOM never stores long-lived credentials. Resource preview constructs text DOM nodes; it does not parse HTML, load remote images or create active links. Connector URLs derive from the operator-configured origin and encoded Agent ID, ignoring untrusted endpoint values returned in records.

## Verification

Command: `node --import tsx --test tests/unit/manager.test.ts`.

Eight deterministic jsdom tests passed: close/native editor preservation, literal hostile labels/exact endpoint copy, rejected origin/cleared bootstrap input, failed publish/local draft retention, canonical history/restore and provenance preservation, offline Settings/local stop semantics, settings export allowlist, inert Resource preview/bounded diff.

Standalone strict TypeScript command passed:

```
npx tsc --noEmit --strict --noUncheckedIndexedAccess --skipLibCheck --target ES2022 --module ESNext --moduleResolution bundler --lib ES2022,DOM,DOM.Iterable --types node apps/userscript/src/manager.ts tests/unit/manager.test.ts
```

Attempted Chromium layout run at 1024×768 and 1920×1080 on a local synthetic page. `/usr/bin/chromium` exists but is a launcher whose `/usr/lib/chromium/chromium` executable is missing; launch exited 127 before a page opened. No screenshot or measured geometry pass is claimed. A fresh Firefox/Violentmonkey profile, actual Cloudflare responses, keyboard walkthrough, rendered geometry and clean operator setup still require T3/T4 verification. jsdom cannot prove rendered scroll behavior.

## Controller integration

`configuration()` returns only origin/paired/browser installation public ID. Required methods are `request`, `health`, `pair`, `currentIdentity`, `copy`, `download`. Optional local adapters cover attaching/reconnecting, immediate stop, draft persistence, private immutable artifacts, read-only probe, settings import and distinct native source backup/restore. Unavailable adapters yield explicit errors. Library export uses `exportResources()` for the gateway's binary ZIP response. Library import preview falls back to the fixed JSON route with `archiveBase64`; commit uses the library revision and per-ID decisions. Resource editing sends full metadata including dependencies, provenance and license.

## Integration review checkpoint

The management request shapes were compared with the actual Registry and Resource handlers. `tests/integration/manager-gateway.test.ts` now runs the manager against a genuine local Miniflare/workerd runtime with SQLite Registry/Workspace bindings and OAuth KV. It exercises pairing, Workspace creation with default permissions, explicit Binding with an empty Draft ID, Agent endpoint, Resource revision publish, metadata/upstream preservation, repeated global scope enable/disable, and a competing administrator revision. The stale manager publish is rejected while retaining its local draft; canonical content remains the other administrator's revision. This is T2 local integration evidence with a synthetic native identity; it does not prove the live Perchance adapter or deployed Cloudflare behavior.

`node --import tsx --test tests/unit/manager.test.ts tests/integration/manager-gateway.test.ts` passed 12 tests (11 unit + 1 local Worker journey). Additional unit cases cover management pagination with a consistent revision, out-of-order Resource selection, and operation recovery requiring inspection evidence plus explicit uncertainty acknowledgement. Recovery passes the original UNKNOWN/PARTIAL record to the controller; it does not replay the mutation or change its status to success.

The integration review also corrected Resource request wrappers/history/delete paths, preserved upstream metadata, refreshed library CAS after assignment changes, aligned the compressed import budget to 8 MiB, and added bounded cursor traversal. Page loads reject mixed registry revisions. The rendered-layout harness is checked in at `tests/e2e/manager-layout.mjs` with original synthetic data and reproducible instructions in `tests/e2e/README.md`. Rendered-layout, T3 Firefox/Violentmonkey and T4 deployed/operator gates remain unverified.

## Operator public-fetch policy

Settings exposes the controller's `fetchHosts()` / `setFetchHosts(hosts)` callbacks as an exact-host allowlist editor. The editor shares the public-fetch URL validator, rejects URLs, wildcards, ports, credentials, IP literals, local names and noncanonical hostnames, and limits the list to 64 entries. Validation completes before the persistence callback; an invalid entry preserves the previous policy. Empty policy denies all public fetches. The interface explains that browser JavaScript cannot independently attest DNS addresses, so approval trusts each host's DNS and service. No fetch permission or POST permission is granted by changing the list.

A focused behavioral test verifies invalid lists preserve the previous policy and a valid public list reaches the persistence callback. Twelve manager unit tests now pass. Settings also makes the candidate's native-preview/provider acceptance gates explicit; gateway connectivity is not represented as a full-parity verification result.

## Credential recovery control

Settings exposes `ManagerClient.recover(origin, secret)` when the controller supports it, for both paired and unpaired installations. The section tells the Operator to rotate `RECOVERY_SECRET` in Cloudflare first, states that recovery revokes old credentials/Grants/leases while preserving the Resource library, and explains that Workspaces remain paused until explicit rebinding and connector authorization. A specific inline revocation checkbox is required. The password field clears before local pause or the recovery request; the checkbox resets for every attempted recovery. A failed request cannot leave the entered recovery secret in the field, markup or exports.

A focused behavioral test confirms no request without explicit revocation approval and verifies the password field is empty when the failing controller call receives the secret. Thirteen manager unit tests pass; live dashboard secret rotation/recovery remains a T4 acceptance item.
