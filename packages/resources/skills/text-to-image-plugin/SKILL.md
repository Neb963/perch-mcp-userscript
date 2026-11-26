---
name: text-to-image-plugin
description: Perch MCP original text-to-image-plugin development reference; expand against current public documentation.
---

# Runtime image generation
Source https://perchance.org/text-to-image-plugin . Import generateImage = {import:text-to-image-plugin}. Runtime-varying images use plugin; fixed assets use MCP generate_image and optionally upload_file. Programmatic call root.generateImage(prompt,{resolution:"512x768",negativePrompt:"blur",seed:123}); verify current result signature (historically dataUrl, canvas, inputs). Supported baseline sizes 512x512, 512x768, 768x512, 768x768. Other options include guidanceScale, removeBackground, gallery metadata; inspect live public source for supported ranges. Some prompt options use suffix (resolution:::512x768). Capture actual selected prompt, don't reroll list to display it. Gallery/save/moderation and imageTags behavior are separate provider features; only use documented public mechanisms. Show loading, handle quota/timeouts and concurrent requests, use safe prompt constraints as appropriate. Preserve exact output bytes, no fake placeholder. Public assets require consent; prefer scratch until accepted. Server jobs use tickets and result validation. Use fixed seed only where backend supports reproducibility.
