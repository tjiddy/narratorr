---
scope: [core]
files: [src/core/utils/book-discovery.ts]
issue: 334
date: 2026-04-04
---
`collectBooks()` has two different child-filtering variables: `audioChildren` (line 96, deep recursive — any child with audio anywhere in subtree) and `immediateAudioChildren` (line 108, direct — children that themselves contain audio files). Disc merge intentionally uses `immediateAudioChildren` so that a folder like `CD1/ + CD2/ + Extra/Bonus Book/` merges the discs while recursing into the deeper descendant separately. Confusing the two in specs or code changes will break the disc-merge contract.
