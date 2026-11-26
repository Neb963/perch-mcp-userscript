---
name: ai-text-plugin
description: Perch MCP original ai-text-plugin development reference; current public-source review and operational guidance.
---

# Runtime AI text
Source https://perchance.org/ai-text-plugin . Import generateText = {import:ai-text-plugin}; call root.generateText in generator JS with instruction, optional startWith, stopSequences, onStart/onChunk/onFinish. onChunk provides textChunk, fullTextSoFar, isFromStartWith; onFinish text includes startWith, generatedText excludes it, liveResponseText can contain edits. Stop delimiter can be included in output; parse strictly. Verify current return/promise and cancellation interface in public source before relying on it. Never inject raw model text as HTML.

Example: root.generateText({instruction:"Describe a mountain village.",onChunk:d=>{result.textContent=d.fullTextSoFar}}). Show pending/cancel/error state, limit overlapping calls, handle rejection and stale generation IDs. Template integration supports outputTo, style, render(data), endButtons, hideStartWith; use documented options. Keep stable prompt prefix and append transcript; summarize older history only as needed. Read current token budget through plugin metadata, do not hardcode historical recommendations. Vision accepts one image attachment via supported instruction format; inspect source for exact Blob/message shape and limits. Server-plugin jobs require browser-issued tickets, not arbitrary server inference. No credentials in PJS/HTML; model output untrusted. Test with mock chunks first and one authorized real generation when needed.

## Current public API details
The retrieved public implementation returns a Promise with attached properties rather than only a completed string. Store the call before awaiting when cancellation is needed: `const run = root.generateText(options);` then `run.stop()` from a user action; `await run` obtains the completed result. The object also exposes inputs and liveResponseText. Do not serialize the Promise or assume its live text is immutable. onStart receives this operation object. onChunk can run many times; batch expensive rendering and never retain an unbounded chunk array.

```javascript
let generation = 0;
let active;
async function startStory(instruction) {
  const current = ++generation;
  active?.stop();
  const run = root.generateText({
    instruction,
    onChunk(data) {
      if (current === generation) outputEl.textContent = data.fullTextSoFar;
    }
  });
  active = run;
  try {
    const result = await run;
    if (current === generation) return result.generatedText;
  } finally {
    if (active === run) active = undefined;
  }
}
```

This example is generator code, executed only in its preview/runtime context. Define outputEl explicitly or obtain it with getElementById. Cancellation can complete with partial text; report it as cancelled/partial in the application rather than presenting it as a full answer. Stale completion handlers must not overwrite a newer run. Treat render(data) as an HTML boundary: use an inspected Markdown sanitizer or build text nodes instead of passing model text into innerHTML.

| Concern | Rule |
|---|---|
| Structured JSON | Validate a complete response against a schema; partial streaming chunks are not valid JSON documents |
| Conversation growth | Retain stable instructions, bound transcript size, and summarize only with explicit application semantics |
| startWith | text includes it; generatedText excludes it; do not append it twice |
| User-edited response | liveResponseText may differ from originally generated text |
| stopSequences | Validate delimiter handling; never assume the delimiter is absent from the result |
| Server use | Page calls createTicket(); server consumes one ticket via jobs.generateText; do not store reusable inference credentials |
| Ticket lifetime | Public docs currently require use within about one minute; queued jobs may wait up to ten minutes |

Mock chunk boundaries in the middle of a Unicode word and a JSON token; test stop before first chunk, two overlapping runs, empty output, callback exception, unavailable provider and quota error. A fresh valid ticket authorizes one job and consumes ordinary user usage. Do not send real inference during synthetic testing.

## Provenance and verification status
Reviewed 2026-11-26 against the public plugin source and documentation URLs in this skill; exact retrieval hashes and access limitations are in documentation/public-source-review.md. This is independently authored guidance, not redistributed upstream source. Public-source review establishes API facts; live provider output, saved metadata and Firefox behavior require their own acceptance evidence.
