# Bounded image result transfer

`read_image`, `generate_image`, and `capture_page_image` can return up to 1 MiB of image bytes. Their base64 encoding can exceed the 512 KiB browser request limit and the 256 KiB inline terminal journal limit. The trusted BrowserController uploads successful image payloads before recording the terminal result. The journal stores a scoped reference. An authorized `operation_status` request resolves the reference, and the MCP formatter emits standard `image` content blocks.

This transport does not execute a tool, fetch a URL, invoke an inference service, expose a download URL, or execute generator JavaScript. The existing Workspace Durable Object stores its private rows in its existing SQLite `records` table. Installation requires no additional Cloudflare binding.

## Authority and limits

| Boundary | Required evidence | Rejection |
| --- | --- | --- |
| Browser request | Current lease credential in the existing authorization header | Existing lease authentication rejects absent, expired, retired, or different-document credentials |
| Image operation | Exact Workspace, operation ID, epoch, binding revision, and tab instance; known image tool; phase `RUNNING`; deadline in the future | `NOT_FOUND`, `STALE_EPOCH`, or `CONFLICT`; zero tool execution |
| Every start/chunk/commit | Fresh Registry authorization of the operation's original Grant and required permissions; local fences checked again after authorization yields | Authorization error or `STALE_EPOCH`; no bytes or publication pointer written |
| Result read | Caller has authorized the current Grant; current Agent and binding revision match the stored `SUCCEEDED` operation | `NOT_FOUND`; zero result bytes |
| Stored image | Exact reference, manifest, SHA-256, byte length, MIME signature, and unexpired `READY` state | `INVALID_INPUT`, `CONFLICT`, or `RESULT_EXPIRED` |

| Resource | Limit |
| --- | --- |
| Combined image bytes per operation | 1,048,576 bytes |
| Image blocks per operation | 4 |
| Raw bytes per chunk | 196,608 bytes (192 KiB) |
| Base64 characters per full chunk | 262,144 |
| Chunks per 1 MiB image | 6 |
| Reserved bytes per Workspace, including incomplete transfers | 8,388,608 bytes |
| Concurrent manifests per Workspace | 64 |
| Manifest lifetime | 600,000 ms from its first successful start; retries do not extend it |
| Supported MIME types | `image/png`, `image/jpeg`, `image/webp`, `image/gif` |

The Workspace includes the earliest manifest expiry in its existing Durable Object alarm and also expires rows during its request expiration pass. Reads independently reject the manifest at `now >= expiresAt`. Delayed alarm delivery cannot expose expired bytes. The next start reserves bytes only after deleting expired manifests and chunks. A disconnected transfer retains its reservation until expiry. Budget exhaustion returns `LIMIT_EXCEEDED`; other Workspaces retain independent budgets.

## Fixed browser protocol

`POST /api/v1/tab/image` accepts only JSON and the existing authenticated lease. The trusted closure supplies identity fields. Agents and generator code receive neither the closure nor the lease credential. Each action rejects unknown fields.

The common fields are `workspaceId`, `operationId`, `epoch`, `bindingRevision`, `tabInstanceId`, and `index`. IDs use the repository opaque-ID format. `index` is an integer from 0 through 3.

| Action | Additional fields | Deterministic behavior |
| --- | --- | --- |
| `start` | `byteLength` integer 1–1,048,576; `sha256` exactly 64 lowercase hexadecimal characters; `mimeType` supported above | Reserve bounded storage and write a `STAGING` manifest. An identical retry returns its existing progress. Changed metadata returns `CONFLICT`. |
| `chunk` | `offset` integer; `data` canonical base64 | Accept only the exact next 192 KiB range, or the shorter final range. A byte-identical duplicate returns current progress. Changed overlap or skipped offset returns `CONFLICT`. Invalid alignment, size, or encoding returns `INVALID_INPUT`. |
| `commit` | None | Require every byte, recompute SHA-256, verify the MIME signature, recheck the local operation fence, then atomically publish `READY`. A valid repeat returns the same committed progress. |

Every successful action returns:

```json
{
  "operationId": "opaque-operation-id",
  "index": 0,
  "nextOffset": 786432,
  "committed": true,
  "expiresAt": 1890000600000
}
```

`nextOffset` ranges from zero through `byteLength`. Only a complete image can have `committed: true`. The browser validates acknowledgements and advances at most six times per image. It does not retry a failed request automatically. Calling the uploader again for the same already-running operation can resume the server-acknowledged identical image; it cannot restart the originating tool.

The following closed schemas describe each request. The shared lease authentication, operation deadline, permission revalidation, fixed chunk ranges, combined budgets, and canonical base64 constraints also apply.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$defs": {
    "id": {"type":"string","minLength":1,"maxLength":128,"pattern":"^[a-zA-Z0-9_-]+$"},
    "common": {
      "type":"object",
      "properties": {
        "workspaceId":{"$ref":"#/$defs/id"},
        "operationId":{"$ref":"#/$defs/id"},
        "epoch":{"type":"integer","minimum":0},
        "bindingRevision":{"type":"integer","minimum":0},
        "tabInstanceId":{"$ref":"#/$defs/id"},
        "index":{"type":"integer","minimum":0,"maximum":3}
      },
      "required":["workspaceId","operationId","epoch","bindingRevision","tabInstanceId","index"]
    }
  },
  "oneOf": [
    {
      "allOf":[{"$ref":"#/$defs/common"}],
      "properties": {
        "action":{"const":"start"},
        "byteLength":{"type":"integer","minimum":1,"maximum":1048576},
        "sha256":{"type":"string","pattern":"^[a-f0-9]{64}$"},
        "mimeType":{"enum":["image/png","image/jpeg","image/webp","image/gif"]}
      },
      "required":["action","byteLength","sha256","mimeType"],
      "unevaluatedProperties":false
    },
    {
      "allOf":[{"$ref":"#/$defs/common"}],
      "properties": {
        "action":{"const":"chunk"},
        "offset":{"type":"integer","minimum":0,"maximum":1048575,"multipleOf":196608},
        "data":{"type":"string","minLength":4,"maxLength":262144,"pattern":"^[A-Za-z0-9+/]*={0,2}$"}
      },
      "required":["action","offset","data"],
      "unevaluatedProperties":false
    },
    {
      "allOf":[{"$ref":"#/$defs/common"}],
      "properties":{"action":{"const":"commit"}},
      "required":["action"],
      "unevaluatedProperties":false
    }
  ]
}
```

## Terminal reference and MCP delivery

The uploader replaces only successful image-tool content with a compact block:

```json
{
  "type": "image",
  "mimeType": "image/png",
  "imageTransfer": {
    "operationId": "opaque-operation-id",
    "index": 0,
    "byteLength": 786432,
    "sha256": "0000000000000000000000000000000000000000000000000000000000000000"
  }
}
```

The zero digest illustrates the field shape; clients must use the SHA-256 of their actual bytes. The reference contains no credentials, public URL, or routing authority. A result from a previous Agent or Workspace binding cannot be resolved through a current connector. A read remains possible after the browser lease ends if the result is still within its lifetime and the current connector retains authorization for the exact Agent and binding.

`ImageTransferHandler.hydrate(summary, scope)` accepts the fixed successful terminal shape. The gateway derives `scope` from current authorization. Hydration loads and verifies only the referenced operation's committed bytes. The existing MCP projector places base64 once in standard MCP `image` content blocks and retains small byte descriptors in text and structured output.

| State or failure | Read result | Recovery |
| --- | --- | --- |
| No manifest | `RESULT_EXPIRED` | Inspect the existing operation; do not repeat a mutating tool automatically |
| `STAGING` or missing chunks | `INVALID_INPUT` or `CONFLICT` | Resume identical bytes only while the original operation remains `RUNNING`; otherwise inspect local workspace data |
| Digest or MIME disagreement | `INVALID_INPUT` | Inspect the existing bytes; the failed commit publishes no readable result |
| `READY`, operation still `RUNNING` | `NOT_FOUND` | Complete the existing terminal reply; never re-execute the image tool |
| `READY`, exact `SUCCEEDED` operation and current scope | Standard MCP image block | No additional browser request |
| Expired manifest | `RESULT_EXPIRED` | Use existing workspace image data; a separate `read_image` may reread it without regenerating it |
| Agent/binding mismatch | `NOT_FOUND` | Use the connector assigned to the exact authorized binding |
| Browser interruption or gateway failure | No fabricated terminal success | Inspect the operation and local image. A failed upload does not roll back an already completed provider or VFS effect. |

The SQLite manifest publication changes only transport state. It never changes source revision, generator persistence, ownership, public listing, or draft identity. Removing or rolling back the feature leaves compact references unreadable; it never authorizes replay. The feature requires no schema migration because its records use the isolated `image/` prefix in the existing versioned record table.

## Verification

Run:

```sh
node --import tsx --test tests/unit/image-transfer.test.ts tests/integration/image-transfer.test.ts
```

The unit suite covers the 1 MiB boundary, bounded requests, final MCP projection, duplicate acknowledgements, changed overlaps, skipped chunks, incomplete commit, changed metadata, invalid base64, wrong hash/MIME, Registry rejection, a lease changing while authorization yields, non-image tools, expired/running/terminal fences, Agent/binding isolation, stored-byte corruption, Workspace and operation reservations, TTL recovery, abort, invalid acknowledgements, and disconnection without automatic retry.

The integration suite runs the actual Worker and SQLite Durable Objects in local Miniflare. It transfers a 768 KiB signature fixture through the authenticated route, records its compact terminal reference, resolves it through scoped operation status, and verifies the existing formatter's standard image block. It rejects another Workspace's operation transfer and another Agent or binding's read. The bytes deliberately test transfer and integrity; the fixture does not prove image decoding, real pixels, external provider behavior, live Firefox execution, Cloudflare deployment, or a third-party connector's rendering.

On 2026-11-26 the focused command passed 14 tests: 12 unit tests and 2 local integration tests. The second integration test revokes Workspace source permission between manifest creation and the next chunk; the gateway rejects that chunk and does not redispatch the originating operation.
