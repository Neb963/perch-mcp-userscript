# Functional parity implementation and remaining evidence

Reviewed 2026-11-26. Public read-only documentation/source review and deterministic adapter tests were performed. No paid generation, production-state mutation, provider sign-in, private Helper request or display capture was performed. None of the findings below is a T3/T4 parity pass.

## Outcome matrix

| Mandatory outcome | Authorized path found | Implemented/tested boundary | Remaining gate |
|---|---|---|---|
| Image asset from prompt | Public `text-to-image-plugin` callable imported into generator preview | Current public signature and bytes/result metadata reviewed; privileged top-frame evaluation prohibited | Preview execution integration, native consent/quota, real image bytes and fidelity |
| Music with lyrics/instrumental/duration | Official ElevenLabs Music API; optional Cloudflare MiniMax alternative | Fixed-endpoint optional ElevenLabs adapter with spend opt-in, bounded transfer, MP3 framing/duration and explicit limitations | Worker-secret administration/integration, actual authorized paid output, decoding/listening and exact control comparison |
| Production server state backup/restore | No general public production equivalent established by reviewed interfaces | No native Helper credential extraction or fabricated successful state result | Existing owner-authorized consistent backup interface or provider-supported production API; true arbitrary-generator parity remains open |
| Unsaved emulator state/files | Public `createServerSocket` testing aids | Exact current method names and destructive restart boundary documented | Real unsaved disposable preview, state+file consistency, restart/recovery proof |
| Actual preview pixels | User-initiated Screen Capture API or another validated native facility | Firefox support and cropping constraints reviewed | Gesture/consent, exact target/crop, no unrelated pixels transmitted, real image output |

Unavailable mandatory outcomes remain release blockers. An alternative is accepted only when observable outcomes meet the contract or an explicit Client Specification amendment approves a difference.

## Public image API

The current public plugin source is available at [getGeneratorsAndDependencies](https://perchance.org/api/getGeneratorsAndDependencies?generatorNames=text-to-image-plugin); public usage is described by [text-to-image-plugin](https://perchance.org/text-to-image-plugin). Import `generateImage = {import:text-to-image-plugin}` in PJS, then invoke `root.generateImage(prompt, {resolution, negativePrompt, seed})` only inside the authorized preview/runtime context. It returns a Promise/string-like result whose `dataUrl`, `canvas` and `inputs` include the actual output and effective seed. These page-controlled assertions still require independent image decoding and dimension/type checks before storing an artifact. Four advertised resolutions remain 512x512, 512x768,768x512 and 768x768. Current source explicitly says referenceImage has no server-side effect; parsed input is not proof of image-to-image capability.

The adapter must never run agent JavaScript in the privileged controller to reach this callable. A fixed allowlisted preview operation or ordinary permissioned page_eval can call the imported function; automatic insertion/import would alter source and needs its normal revision/authorization checks. Do not extract AI Helper tokens or call an undocumented private inference endpoint. User verification and ordinary public plugin quota remain in force.

## Authorized music options

| Option | Authentication and price as reviewed | Fidelity / operational constraint | Decision |
|---|---|---|---|
| ElevenLabs Music | Operator-created scoped API key in `xi-api-key`; official ElevenAPI pricing currently $0.15/min, no finetune selected | `music_v2_5` composition plans carry chunk text/lyrics and optional seed; 3–600s total; seed consistency is qualified, not exact reproducibility | Concrete optional adapter; inactive unless operator enables paid usage and supplies a Worker secret |
| Cloudflare `minimax/music-2.6` | Workers AI binding or scoped Cloudflare API token; official model page currently $0.15/track, lyrics generation$0.01 | Lyrics and instrumental flag documented; exact requested duration/seed controls not established in this interface | Possible single-deployment alternative; no automatic paid binding/provisioning or parity claim |
| Direct MiniMax Music | Existing paying-user API key; current official table$0.15/track for relevant models up to 5 min | Official docs say music/lyrics API unavailable to new users since 2026-08-20 | Do not assume a new operator can obtain access |
| Self-host open music model | User supplies authorized compute/API | Additional infrastructure contradicts the normal one-gateway deployment; quality/lyrics/duration not automatically equivalent | Optional external backend investigation only; no default runtime dependency |

Primary sources: [ElevenLabs compose](https://elevenlabs.io/docs/api-reference/music/compose), [composition plans](https://elevenlabs.io/docs/eleven-api/guides/how-to/music/composition-plans), [API authentication](https://elevenlabs.io/docs/api-reference/authentication), [API pricing](https://elevenlabs.io/pricing/api), [Cloudflare music 2.6](https://developers.cloudflare.com/ai/models/minimax/music-2.6/), [MiniMax pricing/access notice](https://platform.minimax.io/docs/pricing/overview). Prices are observed documentation values, not stored billing promises. A browser subscription does not imply API authorization. No subscription or paid API was purchased or called.

### Optional fixed-endpoint adapter

`apps/gateway/src/media/elevenlabs.ts` exports `generateElevenLabsMusic`, `buildElevenLabsRequest`, `inspectMp3`, typed inputs/results and `MusicProviderError`. The only network destination is `POST https://api.elevenlabs.io/v1/music?output_format=mp3_48000_192`. It sends no cookies, refuses redirects, does not proxy caller-supplied URLs, redacts provider bodies and never retries. Trusted configuration supplies the API key and `paidEnabled:true`; absent opt-in rejects before network dispatch. Keep the key in Cloudflare secret configuration, outside page code, tool arguments, resource records, logs and exports. Narrow provider-key scope and credit budget in the provider dashboard.

Prompt mode supports the provider's guaranteed instrumental flag. Seed is plan-only; requesting guaranteed instrumental plus seed fails with `UNSUPPORTED_CONTROL` before dispatch rather than silently dropping either control. Supplied lyrics are partitioned without byte loss into bounded-duration plan chunks; a seed is forwarded within the documented 0..2147483647 range. The adapter chooses no finetune and explicitly does not store for inpainting. Default provider logging is not disabled because zero-retention access is enterprise-only; operator disclosure is required before real use.

Default duration 60s, accepted product interval 30–300s, maximum response 8 MiB, timeout 300s. MP3 complete-frame validation derives actual encoded duration and detects truncated/invalid framing. This is not a codec/playability audit: result validation explicitly returns playback/lyrics `UNVERIFIED`. Real decoding, audible vocals/instrumental control and lyric truncation still require acceptance. A response interruption, invalid result, 5xx or timeout after dispatch reports `UNKNOWN`; operator must reconcile provider usage/Operation ID before another potentially billable generation. Auth/quota/input rejection is separate. The gateway caller must durably record the Operation ID before calling the adapter, enforce MEDIA/spend authorization, apply Workspace artifact ACL, and prevent repeat admission of an uncertain operation.

Deterministic command `node --import tsx --test tests/unit/music-provider.test.ts`: 8/8 tests pass. They cover parameter branch constraints, lossless lyric plans, exact endpoint/header policy, pre-dispatch denial/cancel, structural MP3 rejection, oversized transfer, secret-safe errors, known rejection versus unknown dispatch and no retry. Synthetic MP3 frames are framing fixtures, not playable music or a provider-output claim. Real account configuration, usage billing, actual media decoding and connector attachment remain unexecuted.

## Production state versus emulator state

Reviewed public [server-plugin source](https://perchance.org/api/getGeneratorsAndDependencies?generatorNames=server-plugin) exposes these helpers on its exported socket factory:

| Helper | Effect | Guard/recovery |
|---|---|---|
| getEmulatorState() | Copy current tab's emulated state | Unsaved editor only; capture identity and revision |
| getEmulatorFiles() | Copy local editable file map, including text/binary/missing entries | Snapshot separately and verify consistency with state |
| setEmulatorState(bytes) | Replace whole emulator state; remaining allocation zeroed | Snapshot first; files reset; open emulated sockets restart with 1012 |
| setEmulatorState(js) | One-time initialization after server top level | Explicit preview execution authorization; no privileged evaluation |
| setEmulatorFile(name,value) | Set local text/bytes or missing marker | Unsaved emulator only; preserve exact bytes |

These are current public candidates, not live-verified integration. Their implementation rejects saved production generators and states no equivalent production helper. That is evidence about this reviewed interface, not proof that no authorized production interface exists anywhere. The public server guide's HTML references separate src documentation files; the complete guide file corpus was not retrieved. General production backup/restore remains unresolved until an actual supported export/restore interface or already implemented owner-authorized RPC provides a consistent complete snapshot and independently verified replacement. Adding a backup RPC to an existing production generator solely to obtain access is not an acceptable substitute for a pre-edit backup.

An owner-designed protocol can satisfy a particular generator: immutable snapshot IDs, schema version, total length/digest, state plus external files, server authorization and compare-and-swap restore. It does not establish arbitrary-generator parity. An interrupted restore becomes reconciliation-only; a second upload is not recovery. Keep backups local/authenticated, never public src or anonymous upload.

## Actual pixels on Firefox

[Screen Capture specification](https://www.w3.org/TR/screen-capture/) and [MDN getDisplayMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia) require human activation, source selection and visible consent; permission cannot be silently persisted. A remote MCP call cannot manufacture the gesture or choose a capture surface. `displaySurface` and preferred-tab options do not force the source. The [MDN compatibility data](https://github.com/mdn/browser-compat-data/blob/main/api/MediaDevices.json) currently records Firefox getDisplayMedia support from 66; [BrowserCaptureMediaStreamTrack/cropTo data](https://github.com/mdn/browser-compat-data/blob/main/api/BrowserCaptureMediaStreamTrack.json) records no Firefox support. These are documentation observations; Violentmonkey content-context exposure/Permissions Policy must still be feature-tested.

A compliant candidate workflow is: operator clicks capture in manager; browser picker grants a stream; local UI chooses and reviews an exact preview region; crop locally; approve the cropped image; stop all tracks; export only approved pixels as a scoped artifact. If native region cropping is unavailable, draw a local capture frame into canvas using an operator-selected region. Do not automatically map iframe CSS coordinates into a window/monitor recording: browser chrome, zoom, devicePixelRatio and source scaling can invalidate that mapping and expose other tabs/editor content. Never transmit the full frame for remote cropping. Surface changes, resize, track ending or ambiguous geometry invalidate a prior crop and require renewed local review.

This path can yield genuine rendered pixels without a separate extension. It requires an operator action and does not yet establish unattended helper-equivalent capture. DOM-to-canvas reconstruction, saved-generator screenshot APIs and a picture of HTML source are different outcomes. Full screenshot parity stays open until a real Firefox disposable preview verifies target identity, crop, color/dimensions, teardown, occlusion/background behavior and tool/attachment delivery.

## Irreducible operator evidence

| Gate | Required concrete evidence | Safe failure state |
|---|---|---|
| Image | Native verified public generation in disposable preview, decoded dimensions/bytes/effective seed | Unavailable; no private backend fallback |
| Music | Operator paid opt-in + limited API key; generated 30–300s audio; decoding/listening; lyrics/control differences | Unknown results held; no automatic repeat |
| Production backup/restore | Documented authorization and consistent state/files; exact digest; disposable replacement; interrupted reconciliation | Backup-required/HOLD; no risky production edits |
| Emulator | Unsaved-only state/files seed and readback, restart and stale revision tests | Reject production context and preserve snapshot |
| Pixels | Human-consented real capture, approved crop, no unrelated pixels, stream cleanup | Capture unavailable or approval pending |

Independent implementation may proceed while these gates are open. They cannot be relabeled passed through fixtures, a disabled tool, generated schemas or this report.

## Lease-bound paid media transport

The gateway route implementation is `apps/gateway/src/media/handler.ts`. `MusicHandler` receives the Workspace's serialized record store, current lease accessor and a Registry authorization callback. The callback must validate the current Grant/assignment and exact epoch/binding with MEDIA plus WRITE_SOURCE; start uses the Registry dispatch permit and read uses current authorization. No route receives a provider key or caller-controlled provider URL. Trusted deployment configuration is `ELEVENLABS_API_KEY` and `PAID_MEDIA_ENABLED=true`; missing configuration denies before paid dispatch.

| Route / exact body additions to lease tuple | Outcome |
|---|---|
| `POST /api/v1/tab/music` + `operationId` | Requires current RUNNING generate_music; uses admitted stored args, never caller overrides; returns READY manifest or in-flight RUNNING |
| `POST /api/v1/tab/music-result` + `operationId,offset` | Current Grant/lease rechecked; offset aligned to 192 KiB; returns bounded base64 chunk with total byte count, digest, next offset and done flag |
| Same result route + `offset:totalBytes,ackSha256` | After browser's verified local commit, exact digest acknowledges consumption; deletes transient chunks, preserves DELIVERED journal |

The lease tuple is `{workspaceId,epoch,tabInstanceId}` under a lease bearer credential. It does not confer cross-Workspace access. The server additionally compares Binding Revision and the exact stored Operation ID, tool and permissions. Parent operation deadline must allow music generation (600s default); transport may wait up to 600s for the start response without retrying. Browser heartbeat renewal remains independent. A closed/expired lease never receives the result.

| Durable media state | Trigger | Next state / inverse branch |
|---|---|---|
| Absent | Current Grant/lease, paid opt-in and capacity pass | Persist INTENT before provider call; denied branches produce no provider request |
| INTENT, active execution | Duplicate start | Return RUNNING; no second provider call |
| INTENT, no active execution after restart | Any attempted resume | UNKNOWN and parent HOLD; never regenerate from intent |
| INTENT | Verified bounded MP3 result | Atomically store chunks plus READY manifest, SHA-256, metadata and 10 min expiry |
| INTENT | Provider proves pre-effect rejection | REJECTED; browser records rejection; distinct from an uncertain paid effect |
| INTENT/READY | Timeout, ambiguous effect, revoked Grant or changed lease after dispatch | UNKNOWN parent; retain available evidence for explicit reconciliation |
| READY | Same current authorized operation requests chunk | Read immutable bytes; wrong offset, digest, scope or expiry rejected |
| READY | Complete matching digest acknowledgement | DELIVERED; retain metadata; future start cannot regenerate |
| READY | Ten-minute result expiry | EXPIRED; bytes deleted; operation is not replayed |

At most 8 MiB transient paid media bytes are retained per Workspace; a prior artifact must be consumed or expire before another generation. Chunk records contain at most 192 KiB raw bytes. Up to 1000 media journal entries are retained; unresolved intent is not automatically evicted. Completed known entries expire after 7 days. Routine records contain hashes/operation metadata, not prompts, lyrics, provider keys or raw provider errors.

The browser must preflight a writable binary target and local storage before dispatch, capture the source Revision, assemble exact chunks, validate their total/digest, retain a local pending artifact, then commit VFS writes against that Revision. A manual edit or failed local commit after paid generation is PARTIAL and must preserve media locally; another generation is not recovery. A lost response under the same still-running lease can retrieve an existing READY manifest without repeating the paid effect. A lost lease/UNKNOWN operation requires operator reconciliation; artifacts are not silently rebound to a new Grant or tab.

Deterministic handler command `node --import tsx --test tests/unit/music-handler.test.ts tests/unit/music-provider.test.ts`: 20/20 pass. Additional cases cover current-Grant checks on start/chunks, source-write permission, cross-tab/Workspace/epoch denial, exact stored arguments, durable intent ordering, in-flight duplicate, restart ambiguity, chunk scope/alignment, digest consumption, expiry, Workspace byte capacity, revoked authorization after paid completion and known pre-effect provider rejection. This is T1 evidence; actual Cloudflare persistence/transport integration and authorized live media remain higher-tier gates.

## Public preview image and upload candidates

`apps/userscript/src/public-media.ts` implements fixed public-plugin operations through an injected **unprivileged native preview evaluator**. `verifiedPreview` defaults false; missing public callables return UNSUPPORTED_INTERFACE before an effect. The code never evaluates JavaScript in the controller/top editor, installs a privileged callback in a page, inserts an import automatically, reads account credentials or accesses a native Helper session. Existing preview imports use `root.generateImage` for image and `root.upload` or `root.uploadPlugin` for upload.

The current public [upload-plugin source](https://perchance.org/api/getGeneratorsAndDependencies?generatorNames=upload-plugin) accepts text or Blob plus optional `{expires:<absolute milliseconds>}`. A data URL passed as a string uploads literal URL text; this adapter decodes tool dataUrl to exact bytes and creates a Blob instead. Public native results contain `{url,error,size,deletionUrl}`; error may arrive through a fulfilled Promise, and url can be String-like. The deletion URL is a destructive capability: the controller stores it through isolated `retainUploadSecret`; model results and resource/settings exports do not contain it. Its domain is validated before retention, and this adapter never invokes it.

| Branch | Candidate behavior |
|---|---|
| Image callable absent or preview gate false | Reject without generation; no source/import edits |
| Image generation returns bytes | Transfer 48 KiB chunks from a random per-operation preview key; retain immutable local artifact before independent decode and revision-checked source write |
| Image source conflict after generation | PARTIAL with retained artifact; no overwrite or regeneration |
| Image returned malformed/oversized data, frame navigated or native reply lost | UNKNOWN/PARTIAL as applicable; no fabricated image |
| Upload path/text/dataUrl | Snapshot exact bytes; text uses UTF-8, dataUrl supports base64 and percent-encoded binary, including empty input |
| Upload staged | Recheck current authorization, native identity and source Revision before public dispatch |
| Native upload receipt | Coerce only bounded primitive URL/size/error/capability fields; fixed public host/path validation |
| Upload success | Independently GET exact bytes from `https://user.uploads.dev/file/...` with cookies omitted and redirects denied; compare length and every byte |
| Provider quota/input rejection | Known-no-effect only for recognized native input/quota/verification error codes |
| Ambiguous server error, missing receipt or byte mismatch | UNKNOWN; preserve the public URL if known; no automatic repeat |
| Secret storage/local verification fails after public upload | PARTIAL/UNKNOWN with safe URL evidence, never repeat publication to recover a response |

Initial negotiated transfer limit is 8 MiB per operation; this is bounded implementation capacity, not the original Helper's 100 MiB upload promise or an upstream quota claim. Larger media remains an explicit parity/measurement gap. Expiry is reported as `availableUntilAtLeast`, because the public service promises minimum retention rather than scheduled deletion. Preview staging keys are deleted in a finally path; navigation also discards this unprivileged state. The parent controller supplies durable operation intent, current MEDIA/UPLOAD_PUBLIC/WRITE_SOURCE policy and native identity checks. No Resource content can enable the trusted preview gate.

The generated-image result includes path, exact bytes/digest, decoded dimensions/type, effective reported seed and local artifact handle. Public page results remain generator-controlled; this does not prove that arbitrary hostile generator code called the expected upstream backend. Real disposable-generator output and provider fidelity are still T3 acceptance. Independent decoding verifies image content rather than trusting a data URL prefix alone.

Command `node --import tsx --test tests/unit/public-media.test.ts`: 11/11 deterministic fixture tests pass, plus focused strict TypeScript checks. The fixture VM models only an unprivileged generator with synthetic public-plugin functions; it is not a production JavaScript isolation mechanism and has no GM APIs, gateway secrets or account objects. Tests cover quoted hostile prompt data, absent interfaces, bounded image chunk transfer, retained partial writes, exact text/binary/empty upload bytes, private deletion capability exclusion, independent mismatching readback, hostile URLs, fresh revision/permission checks, malformed data URLs and native rejection versus unknown branches. Real Firefox preview transport, provider quota/verification, genuine media output, public file readback and cleanup remain higher-tier gates.
