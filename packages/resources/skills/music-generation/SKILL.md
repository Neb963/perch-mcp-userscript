---
name: music-generation
description: Perch MCP original music-generation development reference; expand against current public documentation.
---

# Development-time music assets
Original helper produces fixed audio assets; no public runtime Perchance music-generation plugin established. MCP generate_music must use an authorized backend, not private native Helper credentials or session reuse. Inputs style, isInstrumental, optional lyrics/seed/userRequestedSeconds, outputPath. Style describe genre, mood, tempo, instruments, vocal language; lyrics structured with verse/chorus/bridge section labels. Instrumentals omit lyrics or use section markers. Requested duration baseline 30–300s; report actual duration, unsupported seed/lyrics control and truncation. Do not claim equivalent capability from stock music or a fake audio file. Keep generated output in scratch until approval; use upload_file or src to ship public asset only with permission. Browser Audio playback must start on user gesture; handle play rejection, loop and volume/mute. For transitions, fade between preloaded tracks, cancel previous transitions. Test audio decoding, duration, looping, asset path and user activation. Provider availability and costs are unresolved parity gate, not an instruction to bypass them.
