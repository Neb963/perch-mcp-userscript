---
name: text-to-image-plugin
description: Perch MCP original text-to-image-plugin development reference; current public-source review and operational guidance.
---

# Runtime image generation
Source https://perchance.org/text-to-image-plugin . Import generateImage = {import:text-to-image-plugin}. Runtime-varying images use plugin; fixed assets use MCP generate_image and optionally upload_file. Programmatic call root.generateImage(prompt,{resolution:"512x768",negativePrompt:"blur",seed:123}); verify current result signature (historically dataUrl, canvas, inputs). Supported baseline sizes 512x512, 512x768, 768x512, 768x768. Other options include guidanceScale, removeBackground, gallery metadata; inspect live public source for supported ranges. Some prompt options use suffix (resolution:::512x768). Capture actual selected prompt, don't reroll list to display it. Gallery/save/moderation and imageTags behavior are separate provider features; only use documented public mechanisms. Show loading, handle quota/timeouts and concurrent requests, use safe prompt constraints as appropriate. Preserve exact output bytes, no fake placeholder. Public assets require consent; prefer scratch until accepted. Server jobs use tickets and result validation. Use fixed seed only where backend supports reproducibility.

## Results, controls and honest limitations
Await the public generateImage call and use the result's dataUrl/canvas/inputs fields after validation. The result is also string-like; do not mistake a loading placeholder or plain error string for decoded image bytes. Read the effective seed from returned inputs because an unspecified seed is provider-selected. Keep requested and effective parameters together in an application record.

```javascript
const result = await root.generateImage("A mountain village, watercolor", {
  resolution: "512x768",
  negativePrompt: "blur",
  seed: 123
});
if (typeof result?.dataUrl !== "string" || !result.dataUrl.startsWith("data:image/")) {
  throw new Error("Image generation did not return an image");
}
imageEl.src = result.dataUrl;
```

Run this only after explicit authorization for real inference. It illustrates runtime plugin use, not permission for Perch MCP to call a private inference backend. Keep fixed development assets in scratch before an authorized public upload or src Save.

Current public source accepts the four baseline resolutions 512x512, 512x768, 768x512 and 768x768. CSS display dimensions are separate from generated image dimensions. Prompt suffixes can affect seed/resolution/guidance settings; avoid conflicting explicit and suffix settings. The public source explicitly marks referenceImage as disabled server-side and ineffective for general traffic; parsing an option is not evidence of working image-to-image. Do not promise reference guidance until an authorized real output proves it.

| Concern | Required behavior |
|---|---|
| Repeated clicks | Bound active jobs; newer run cannot be overwritten by older completion |
| Preview rerender | Dispose old widgets/listeners, preserve intentionally retained results |
| Provider failure | Distinct error/verification/quota state; no fake placeholder success |
| Background removal | Verify alpha channel and actual pixels; document that it is additional processing |
| Gallery metadata | Deliberate consent; saving to a shared gallery is separate publication |
| Reproducibility | Record effective seed/settings; future backend/model changes may alter pixels |

Test output decoding, dimensions, MIME mismatch, wrong message/frame, cancellation, repeated callbacks, quota denial and unsupported settings with fixtures. A real output requires appropriate native verification and provider usage permission. Avoid copying or forking coupled upstream plugin internals; import and wrap the public API.

## Provenance and verification status
Reviewed 2026-11-26 against the public plugin source and documentation URLs in this skill; exact retrieval hashes and access limitations are in documentation/public-source-review.md. This is independently authored guidance, not redistributed upstream source. Public-source review establishes API facts; live provider output, saved metadata and Firefox behavior require their own acceptance evidence.
