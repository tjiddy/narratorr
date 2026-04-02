---
scope: [frontend]
files: [src/client/components/settings/IndexerCard.test.tsx]
issue: 291
source: review
date: 2026-04-02
---
IndexerFields tests using a local wrapper don't prove the parent IndexerCard wiring works. When adding parent-to-child prop passing (watch/setValue), always write a create-flow integration test through the real parent component that exercises type switching, default population, user interaction, AND form submission with payload assertions. Local wrapper tests only prove the child works in isolation.
