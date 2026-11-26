---
name: comments-plugin
description: Perch MCP original comments-plugin development reference; expand against current public documentation.
---

# Comments and chat
Source https://perchance.org/comments-plugin . Import commentsPlugin = {import:comments-plugin}, instantiate root.commentsPlugin({channel:"my-chat",...}). Each channel separate; changing suffix/order can create another channel. Native widget usually survives update; replacedDuringUpdate opts into replacement. Capture instance for submit, inputText, hooks onLoad/onComment/onInputTextChange/beforeSubmit; beforeSubmit null cancels, string replaces. Read current public docs for full option shape. Incoming message content is unsafe HTML; display text or sanitize. Channel names typically lowercase alphanumeric/hyphen, special permission suffixes: +u:alice|bob, +ids:channel, +auth:<public-key-hash>; combine only per documented syntax. Do not assume channel names provide secrecy. Secret-plugin challenge auth restricts posting, not necessarily reading.

Moderation: adminPasswordHash derived as SHA-256 of "perchance-comments-plugin|" plus password; never embed password. Admin native login, rateLimits, bannedWords, bannedUsers and moderation hooks; shared IP bans have collateral impact. Custom emoji hosted on Perchance uploads, slash commands and style options supported; inspect public source for exact properties. Use explicit opt-in before sending messages or moderating real channels. Test with disposable channel, not public users.
