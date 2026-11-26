---
name: upload-plugin
description: Perch MCP original upload-plugin development reference; expand against current public documentation.
---

# File hosting
Source https://perchance.org/upload-plugin and https://perchance.org/upload . Import uploadPlugin = {import:upload-plugin}. Verify current public source for callable upload signature and result URL/error/deletion semantics before coding. Uploaded files hosted publicly (user.uploads.dev); never upload private keys, state backups or sensitive scratch without explicit authorization. Native srcState files are different: staged bytes become saved manifest only after native Save. Standalone upload may require native verification, support chunking/expiry and deduplicate bytes; verify length/digest. Retain deletion capability privately, do not delete shared asset merely because src path removed. Editable text files and temporary uploads have distinct limits; editable names generally lowercase alphanumeric/hyphen, _ may be server-write-only. Server job tickets enforce authorization. Do not hardcode historical daily quotas; surface actual provider errors. Test empty/binary bytes, quota/type rejection, aborted and uncertain upload, no automated CAPTCHA bypass.
