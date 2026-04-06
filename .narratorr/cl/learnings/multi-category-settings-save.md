---
scope: [frontend]
files: [src/client/pages/settings/SearchSettingsSection.tsx, src/client/pages/settings/FilteringSettingsSection.tsx]
issue: 389
date: 2026-04-06
---
When a single settings card form reads/writes fields from multiple schema categories (e.g., search + rss + quality.protocolPreference), the `toFormData` and `toPayload` helpers must cross-reference category boundaries. The mutation sends a merged payload like `{ search: {...}, rss: {...}, quality: { protocolPreference } }` — the server's `updateSettings` merges partial category updates correctly. This pattern is safe because settings.service.ts deep-merges partial updates per category.
