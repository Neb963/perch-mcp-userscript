# R04 — Canonical physical layout and derived Registry index experiment

Authority: v0.3 §8.1 **Strive <=120 SQL reads/40 writes per native full lifecycle, including amortized cleanup; v0.2 already unmet.** Target is not an exception to revocation, replay, late-result ACL or unknown-effect recovery. All evidence is Miniflare/local SDK with network disabled; browser sends synthetic terminal receipts, no Perchance/Cloudflare deployment.

## Physical canonical records

CI [46109926275](https://github.com/Neb963/perch-mcp-userscript/actions/runs/46109926275), exact SHA `1b053013922865827de64a95f059d2f36e1fd084`, passed tests, build, installer hash, Worker dry-run and native/legacy synthetic cost benchmarks. Fresh `records` tables now use a composite `PRIMARY KEY(key,part) WITHOUT ROWID`; pre-existing rowid tables are retained and readable with the identical source. No migration, wipe or automatic re-pairing.

| Workload (fresh-install) | Native reads | Native writes | Legacy reads | Legacy writes |
| --- | ---: | ---: | ---: | ---: |
| Single read lifecycle | 194 | 54 | 250 | 80 |
| Ten separate writes | 2,340 | 544 | 2,940 | 800 |
| One grouped 10-file write | 231 | 54 | 294 | 80 |
| Ten separate mixed actions | 2,115 | 525 | 2,720 | 785 |
| One mixed 10-action batch | 231 | 54 | 294 | 80 |

Previous rowid canonical layout, same synthetic workload at ce51cf6: **native 193/57, legacy 246/85**. Thus fresh `WITHOUT ROWID` improves native writes by 3, at the cost of 1 read; write quotas are relatively more constrained, so this is a useful but minor reduction. It does **not** demonstrate migration savings for existing deployments. The immutable 120/40 denominator is unchanged.

## Scoped index proposal

`registry_kind_v1` on `registry_entity_v1(kind,key)` duplicates an ordered prefix of the canonical key that is already `kind/ID`. Ordinary terminal and permit state updates mutate this secondary B-tree. New Registry installations can omit it; existing Registry DOs retain it until a distinct operator-approved migration.

To preserve bounded pagination and corruption isolation, `RegistryIndex.page()` uses `key>=prefix AND key<prefix+U+FFFF ORDER BY key LIMIT 100 OFFSET ?`. SQLite chooses the WITHOUT ROWID primary key. Reads check the derived `kind` against the canonical prefix and reject corruption. Expired approvals still use an explicit `expires>?` filter; the legacy singleton Library remains a distinct path. `registry_due_v1`, `registry_workspace_v1` and `registry_approval_v1` stay intact for expiration, holds, Grant discovery and approval checks.

## Qualification contract

- Test new physical index list and primary key EXPLAIN plan; 213 Grant entries across three pages and exact Grant/workspace scoping.
- Test 10 approval records including 3 expired, incremental canonical delete, existing historical kind index, and corrupt derived kind fail-closed.
- Run entire existing test suite and full native/legacy 5-stage benchmark. Reject the optimization if it increases overall row costs or regresses permissions, paging, Activity, retention or replay.
- If there is a real improvement, explicitly distinguish fresh-install from previously created Durable Objects. No production reindex, reset, or deployment occurs.

**Current release gate**: 120/40 remains unmet, actual preview pixels and OWNER verification remain unqualified.