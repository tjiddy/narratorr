---
scope: [frontend]
files: [src/client/components/DirectoryBrowserModal.tsx]
issue: 484
source: review
date: 2026-04-12
---
DirectoryBrowserContent was documented as Strategy C (mount/unmount wrapper) but still needed its inner `useEscapeKey(true, ...)` changed to `useEscapeKey(isOpen, ...)` per AC1. The wrapper pattern made it easy to overlook because the component is always mounted when visible — `true` is functionally correct but inconsistent with the Strategy A contract. The plan should have explicitly flagged inner-content components that need prop threading even when the outer wrapper handles visibility.
