---
name: ai-text-plugin
description: Perch MCP original ai-text-plugin development reference; expand against current public documentation.
---

# Runtime AI text
Source https://perchance.org/ai-text-plugin . Import generateText = {import:ai-text-plugin}; call root.generateText in generator JS with instruction, optional startWith, stopSequences, onStart/onChunk/onFinish. onChunk provides textChunk, fullTextSoFar, isFromStartWith; onFinish text includes startWith, generatedText excludes it, liveResponseText can contain edits. Stop delimiter can be included in output; parse strictly. Verify current return/promise and cancellation interface in public source before relying on it. Never inject raw model text as HTML.

Example: root.generateText({instruction:"Describe a mountain village.",onChunk:d=>{result.textContent=d.fullTextSoFar}}). Show pending/cancel/error state, limit overlapping calls, handle rejection and stale generation IDs. Template integration supports outputTo, style, render(data), endButtons, hideStartWith; use documented options. Keep stable prompt prefix and append transcript; summarize older history only as needed. Read current token budget through plugin metadata, do not hardcode historical recommendations. Vision accepts one image attachment via supported instruction format; inspect source for exact Blob/message shape and limits. Server-plugin jobs require browser-issued tickets, not arbitrary server inference. No credentials in PJS/HTML; model output untrusted. Test with mock chunks first and one authorized real generation when needed.
