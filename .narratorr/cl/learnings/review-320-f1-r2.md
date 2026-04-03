---
scope: [frontend]
files: [src/client/pages/book/AudioPreview.tsx]
issue: 320
source: review
date: 2026-04-03
---
When rendering both a custom play/pause button AND native `<audio controls>`, the custom button must listen for the audio element's `play`, `pause`, and `ended` events — not just manage state through its own click handler. Otherwise the two control surfaces desync. This is a general rule: any component that mirrors media state must subscribe to the element's events, not just its own actions.
