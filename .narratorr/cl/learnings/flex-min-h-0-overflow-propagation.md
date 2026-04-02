---
scope: [frontend]
files: [src/client/components/SearchReleasesModal.tsx, src/client/components/WelcomeModal.tsx]
issue: 306
date: 2026-04-02
---
When a parent has `max-h-[Xvh] flex flex-col`, every intermediate flex child between it and the `overflow-y-auto` element must have `min-h-0` (and usually `flex-1 flex flex-col`). Without `min-h-0`, flex children default to `min-height: auto` and grow past the parent's max-height. The WelcomeModal pattern (`flex flex-col min-h-0 flex-1 overflow-hidden`) is the canonical fix.
