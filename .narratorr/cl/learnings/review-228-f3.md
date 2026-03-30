---
scope: [frontend]
files: [src/client/pages/settings/NamingSettingsSection.test.tsx]
issue: 228
source: review
date: 2026-03-30
---
Component tests that only assert label presence ("Multi-file" text exists) don't prove the token-map contract (which tokens are passed to the renderer). When a component passes different data to the same function for different preview rows, spy on the function and assert the exact arguments for each call. Label-only assertions are necessary but not sufficient.
