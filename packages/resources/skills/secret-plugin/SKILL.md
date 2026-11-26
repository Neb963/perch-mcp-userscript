---
name: secret-plugin
description: Perch MCP original secret-plugin development reference; current public-source review and operational guidance.
---

# Public-key encryption
Source https://perchance.org/secret-plugin . Import secretPlugin = {import:secret-plugin}. root.secretPlugin.generateKeyPair() historically returns {public,private}; encrypt(text,public), decrypt(ciphertext,private) synchronous. Never embed private key in source, logs, URL or public storage. Losing private key loses access. Randomized ciphertext differs for same plaintext, so compare plaintext/digest not ciphertext. Source describes ML-KEM scheme and versioned textual encodings; verify implementation, don't equate encryption with sender authentication. For files, encode as documented (data URL). Comments permission suffix +auth:<SHA-256 public key> uses publicKey and decryptChallenge callback in submit auth object. Validate identity and trust boundaries separately. Test wrong key and malformed input without leaking plaintext. Do not use this plugin for our gateway OAuth or credential storage.

## Trust model and wire compatibility
The reviewed implementation generates versioned textual public/private keys and ciphertext. It combines an ML-KEM-768 key encapsulation implementation, HKDF/SHA-256 derivation, AES-GCM and compression. These are implementation observations, not a new security audit. Use the imported public plugin and its complete encoded values; do not copy the bundled cryptographic implementation, parse out key internals, or substitute ordinary base64 for its custom encoding.

Public-key encryption answers who can decrypt, not who authored a message. If an application needs authenticated senders, use an independent authenticated identity/proof mechanism. Anyone knowing a public key can encrypt to it. A display nickname or ciphertext prefix does not prove authorship. Pin recipient identity using a trusted public-key fingerprint and show a deliberate key-change flow.

```javascript
const keys = root.secretPlugin.generateKeyPair();
const ciphertext = root.secretPlugin.encrypt("Synthetic message", keys.public);
const plaintext = root.secretPlugin.decrypt(ciphertext, keys.private);
if (plaintext !== "Synthetic message") throw new Error("Round-trip mismatch");
```

This is a synthetic test only. Persist the private key through a user-controlled encrypted backup flow; do not place it in PJS, HTML, public src files, uploaded plaintext, URLs, comments or telemetry. Losing the only private key loses encrypted data. The plugin does not supply our MCP credential protection or OAuth implementation.

| Failure case | Application behavior |
|---|---|
| Wrong key or malformed encoding | Show decryption failure; retain original ciphertext for recovery |
| Corrupted ciphertext | Reject; do not display partial plaintext |
| Huge compressed payload | Bound encoded and decoded lengths before use; avoid freezing the UI |
| Private key passed as encrypt key | Reject before publishing anything |
| Recipient key changes | Require deliberate identity verification; preserve access to old data |
| Repeated encryption | Expect distinct ciphertexts; compare recovered plaintext or digest |

For comments auth, public source expects `{publicKey, decryptChallenge}` at submit; bind challenge handling to the intended channel and pending submission. A public-key proof allows a permission decision at that boundary; it does not turn a public channel into private storage. Test stale challenges, wrong recipient and rejected decryption without logging secrets.

## Provenance and verification status
Reviewed 2026-11-26 against the public plugin source and documentation URLs in this skill; exact retrieval hashes and access limitations are in documentation/public-source-review.md. This is independently authored guidance, not redistributed upstream source. Public-source review establishes API facts; live provider output, saved metadata and Firefox behavior require their own acceptance evidence.
