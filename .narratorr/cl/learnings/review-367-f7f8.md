---
scope: [scope/frontend]
files: [src/client/pages/discover/DiscoverySettingsSection.tsx, src/client/pages/discover/DiscoverySettingsSection.test.tsx]
issue: 367
source: review
date: 2026-03-16
---
Settings validation tests only covered one boundary (intervalHours=0) and missed maxSuggestionsPerAuthor bounds entirely. Save mutation tests only asserted the API call, not success consequences (toast, dirty reset, cache invalidation) or failure (error toast). Prevention: for every Zod schema with min/max bounds, test both boundary edges. For every form save mutation, test success side effects (toast, form state reset) and error side effects (error toast with message).
