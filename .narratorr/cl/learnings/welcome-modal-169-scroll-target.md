---
scope: [frontend]
files: [src/client/components/WelcomeModal.tsx]
issue: 169
date: 2026-03-28
---
The `WelcomeModal` fixed overlay (`fixed inset-0`) is NOT the scrollable element — the inner `flex-1 overflow-y-auto` content div is. The spec initially pointed at the overlay, but scroll-to-top must target the inner ref. When a modal uses a fixed full-screen overlay as a flex container and an inner div for overflow, always attach `scrollableRef` to the inner scrollable div, not the overlay.
