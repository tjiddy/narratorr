---
scope: [frontend]
files: [src/client/pages/settings/NamingSettingsSection.test.tsx]
issue: 228
source: review
date: 2026-03-30
---
When a keyboard handler has two branches (Backspace and Delete), testing only one branch is insufficient — the other branch could regress independently. The spec listed both directions; the test should cover both. Prevention: for each key-handling if/else, ensure both branches have a test.
