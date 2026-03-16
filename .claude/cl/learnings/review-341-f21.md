---
scope: [scope/frontend]
files: [src/client/pages/settings/SearchSettingsSection.test.tsx]
issue: 341
source: review
date: 2026-03-12
---
When fixing F20 (adding inline error rendering for blacklistTtlDays and rssIntervalMinutes), didn't add corresponding tests for the new branches. This is the same gap as F13-F19 (adding validation without tests) but at a smaller scale — adding error rendering without tests. Every new render branch needs a test proving it renders.
