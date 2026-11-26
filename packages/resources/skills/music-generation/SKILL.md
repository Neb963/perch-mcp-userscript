---
name: music-generation
description: Perch MCP original music-generation development reference; current public-source review and operational guidance.
---

# Development-time music assets
Original helper produces fixed audio assets; no public runtime Perchance music-generation plugin established. MCP generate_music must use an authorized backend, not private native Helper credentials or session reuse. Inputs style, isInstrumental, optional lyrics/seed/userRequestedSeconds, outputPath. Style describe genre, mood, tempo, instruments, vocal language; lyrics structured with verse/chorus/bridge section labels. Instrumentals omit lyrics or use section markers. Requested duration baseline 30–300s; report actual duration, unsupported seed/lyrics control and truncation. Do not claim equivalent capability from stock music or a fake audio file. Keep generated output in scratch until approval; use upload_file or src to ship public asset only with permission. Browser Audio playback must start on user gesture; handle play rejection, loop and volume/mute. For transitions, fade between preloaded tracks, cancel previous transitions. Test audio decoding, duration, looping, asset path and user activation. Provider availability and costs are unresolved parity gate, not an instruction to bypass them.

## Provider integration contract
No public Perchance runtime music plugin or general authorized music endpoint was established by this review. Native Helper music is a private-session capability; its presence does not authorize extracting a session token. A configured external provider is acceptable only after an authorized API contract and an actual playable output establish comparable outcomes. Stock music, tones and fabricated MP3 headers do not satisfy generate_music.

| Field | Handling |
|---|---|
| style | Preserve the user's genre, mood, tempo, instrumentation, language and arrangement; bound request length |
| isInstrumental | Require a provider control or document that reliable instrumental enforcement is unsupported |
| lyrics | Send only with permission; report provider truncation and unsupported section syntax |
| seed | Preserve only when provider documents it; never label a random request deterministic |
| userRequestedSeconds | Validate 30–300s request; record actual decoded duration and provider maximum |
| outputPath | Snapshot exact audio bytes into the assigned Workspace; do not expose a public URL by default |
| interrupted job | Keep provider job/Operation ID, poll status or reconcile; never create another paid job merely to recover a response |

Separate generation from publication. Agent output should include the provider name, requested and effective settings, media type, byte length, digest, actual duration, path and any unsupported controls. Never export the provider credential with a resource, settings backup or artifact. An external API key is not a Perchance account token and must remain in an isolated operator-controlled secret store.

## Audio integration
Decode the output before declaring success; a successful HTTP status can contain JSON error text. Start playback from a user gesture, handle autoplay rejection, release object URLs, and expose mute/volume/pause. A loop can have an audible seam even when an HTML audio element loops correctly; inspect the join rather than promising seamless audio. Avoid simultaneous background tracks after repeated update(). Crossfades need cancellation so a new scene cannot revive an older track.

Synthetic verification covers pending/success/rejected/timeout/unknown job states, malformed audio, unsupported controls, quota denial and duplicate callbacks. Real acceptance still needs an operator-authorized provider account, disposable generation budget, decoded media and target web-client attachment behavior. Keep the tool unavailable with a concrete recovery message until those prerequisites are satisfied.

## Reviewed authorized alternative
An optional fixed-endpoint ElevenLabs adapter is implemented in the gateway source. Official references: https://elevenlabs.io/docs/api-reference/music/compose , https://elevenlabs.io/docs/eleven-api/guides/how-to/music/composition-plans , https://elevenlabs.io/pricing/api . Review date 2026-11-26. API access requires an operator-created scoped key and explicit paid opt-in; public pricing currently lists $0.15/min. Never infer permission from a subscription or from this skill.

The documented music_v2_5 API offers prompt mode with guaranteed instrumental control, or composition-plan chunks carrying lyrics and optional seed. Seed and the guaranteed instrumental flag cannot be combined in this adapter; the caller must choose explicitly. Seed does not promise bit-identical output across provider updates. The adapter preserves lyric text in its request, bounds total duration to the product 30–300s interval, and validates MP3 framing/duration. Playback and lyric fidelity remain UNVERIFIED until real decoding/listening. Provider timeouts after dispatch stay UNKNOWN and must not trigger another paid generation. Key administration, tool integration and real-output acceptance remain separate gates.

Cloudflare also documents a paid minimax/music-2.6 binding; exact duration/seed fidelity was not established there. Direct MiniMax music API access is officially closed to new users since 2026-08-20, so do not promise a universally available direct endpoint. See the repository's PARITY_IMPLEMENTATION report for the full comparison and source links.

## Provenance and verification status
Reviewed 2026-11-26 against the public plugin source and documentation URLs in this skill; exact retrieval hashes and access limitations are in documentation/public-source-review.md. This is independently authored guidance, not redistributed upstream source. Public-source review establishes API facts; live provider output, saved metadata and Firefox behavior require their own acceptance evidence.
