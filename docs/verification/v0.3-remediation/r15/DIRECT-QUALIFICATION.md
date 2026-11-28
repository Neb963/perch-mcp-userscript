# R15 — browser effect-boundary capability permission qualification

**Exact tested source:** [`1a859abcaf0787e3f35d3b29c9b0850207dab29a`](https://github.com/Neb963/perch-mcp-userscript/commit/1a859abcaf0787e3f35d3b29c9b0850207dab29a), source tree `a17a704144a1132f535555434f7dda90cf7088a6`. [CI 46161586058](https://github.com/Neb963/perch-mcp-userscript/actions/runs/46161586058) **SUCCESS — 737 PASS, 0 FAIL, 1 historical SKIP**; typecheck, full Workerd/unit suite, native/legacy benchmarks, package and checksum verification, and non-deploying Worker dry-run.

| Clause | Verified behavior from actual browser executor |
| --- | --- |
| S03-031 | WRITE_SOURCE-only `write` private transfer start produced a durable transferId without publishing source; same permission ceiling rejected commit with SCOPE_DENIED before effect. READ_SOURCE + WRITE_SOURCE committed identical staged zero-byte file with successful exact readback and one source-publication permit. |
| S03-033 | Guarded `delete` rejected both READ_SOURCE-only and WRITE_SOURCE-only authorization with zero revision mutation/permit. READ_SOURCE + WRITE_SOURCE with matching file digest deleted the intended private source file and returned SUCCEEDED. |
| S03-035 | Guarded `rename` rejected each missing capability with no revision mutation/permit. Both capabilities and exact SHA-256 source/destination-absent conditions produced a single verified rename and unchanged content bytes. |
| S03-037 | `list_files` denied WRITE_SOURCE-only before returning metadata or permits; READ_SOURCE returned exactly the selected file metadata, no file contents and no publication permit. |
| S03-049 | `execute_js` denied COMPUTE-only when declared filesystem read required READ_SOURCE or declared write required WRITE_SOURCE; COMPUTE + READ_SOURCE ran isolated QuickJS and returned the exact source bytes using a read-view permit. |

**Test:** `tests/unit/development-v2.test.ts` — `R15 guarded filesystem and compute authorization enforce exact capability ceilings`; runs actual `executeDevelopment`, `FilesystemV2`, `VirtualFileSystem` and QuickJS. Assertions directly observe resulting VFS revision, expected bytes, durable transfer metadata, publication/read permits and errors; no privilege checks are mocked away.

**Register delta:** exactly five `NOT_STARTED`→`PASS` in `SPEC-00-05.md`. Total 1,317 = **141 PASS, 4 FAIL, 1,133 NOT_STARTED, 24 DEFERRED_OWNER, 1 BLOCKED_FEASIBILITY, 14 SUPERSEDED**. Does not qualify unrelated operation recovery, public preview pixels, native SQL or owner acceptance.

**Artifact:** [run 46161586058 artifact 15270171961](https://github.com/Neb963/perch-mcp-userscript/actions/runs/46161586058/artifacts/15270171961); candidate ZIP SHA-256 `af0c8182158288ccf0f2416fe10727dd34a5f42fc1b6867728f35062ce5c370d`, userscript TXT/JS SHA-256 `363e96ca254329e10604c2b8287743b788a38e1806657e21a270ca80b85c7bb0`.
