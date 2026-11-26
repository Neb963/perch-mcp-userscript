---
name: secret-plugin
description: Perch MCP original secret-plugin development reference; expand against current public documentation.
---

# Public-key encryption
Source https://perchance.org/secret-plugin . Import secretPlugin = {import:secret-plugin}. root.secretPlugin.generateKeyPair() historically returns {public,private}; encrypt(text,public), decrypt(ciphertext,private) synchronous. Never embed private key in source, logs, URL or public storage. Losing private key loses access. Randomized ciphertext differs for same plaintext, so compare plaintext/digest not ciphertext. Source describes ML-KEM scheme and versioned textual encodings; verify implementation, don't equate encryption with sender authentication. For files, encode as documented (data URL). Comments permission suffix +auth:<SHA-256 public key> uses publicKey and decryptChallenge callback in submit auth object. Validate identity and trust boundaries separately. Test wrong key and malformed input without leaking plaintext. Do not use this plugin for our gateway OAuth or credential storage.
