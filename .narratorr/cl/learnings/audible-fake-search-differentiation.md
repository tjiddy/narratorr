---
scope: [infra, core]
files: [e2e/fakes/audible.ts, src/core/metadata/audible.ts]
issue: 616
date: 2026-04-17
---
The Audible fake must differentiate match-job searches (structured `title` param → empty results for confidence 'none') from BookEditModal keyword searches (`keywords` param → one generic product so the user can select metadata and upgrade confidence). Without this differentiation, the Edit Metadata flow has nothing to click — `selectedMetadata` stays null, `handleSave` sends `metadata: undefined`, and confidence never upgrades from 'none' to 'medium'. The query param shape (`title` vs `keywords`) is the reliable discriminator because AudibleProvider.searchBooks uses structured params when `options.title` is set (match job), and falls back to `keywords` for the general metadata search (modal).
