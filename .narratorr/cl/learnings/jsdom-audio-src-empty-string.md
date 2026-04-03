---
scope: [frontend]
files: [src/client/pages/book/AudioPreview.test.tsx]
issue: 320
date: 2026-04-03
---
In jsdom, setting `audio.src = ''` resolves to the base URL (e.g., `http://localhost:3000/`), not an empty string. Tests asserting cleanup should use `expect(audio.src).not.toContain('/api/...')` instead of `expect(audio.src).toBe('')`.
