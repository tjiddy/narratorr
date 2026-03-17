# Technical Debt

- **CSP unsafe-inline**: `'unsafe-inline'` was added to scriptSrc in helmet config to allow the injected `window.__NARRATORR_URL_BASE__` config script. Consider using a nonce-based approach instead for stricter CSP. (discovered in #284)
- **registerStaticAndSpa untested**: The HTML injection and SPA fallback logic in `server-utils.ts` isn't unit tested because it requires a real filesystem with `dist/client/index.html`. An integration test with a temp directory would be more robust. (discovered in #284)
- **QualityGateService max-lines override**: File grew to 580 lines after adding `getQualityGateDataBatch()`. The SSE emission calls are mechanical boilerplate — consider extracting a helper. (discovered in #283, worsened in #356)
- **Activity/event-history routes still use string-matching error handling**: Routes match error messages via `message.includes('not found')` instead of typed error classes. (discovered in #359)
- **CredentialsSection lacks dedicated test file**: Tested indirectly through SecuritySettings integration tests only. (discovered in #358)
- **ImportListsSettings form labels lack htmlFor**: Labels without `htmlFor`/`id` pairing, inaccessible to screen readers. (discovered in #285)
- **jobs/search.ts re-exports from search-pipeline**: Backward compat re-exports that can be cleaned up when all consumers import directly. (discovered in #357)
- **BookListService.getAll() slim select**: Explicit column list in `book-list.service.ts` must be kept in sync with schema. Consider deriving from full definition minus excluded. (discovered in #355, service renamed in #397)
- **jobs/index.test.ts hardcoded job count**: `toHaveLength(12)` will break every time a new job is added. (discovered in #366)
- **createMockServices hardcoded service names**: Service list in `helpers.ts` must be manually updated. (discovered in #366)
- **computeResurfacedScore uses naive heuristic**: Resurfaced snoozed suggestions get `SIGNAL_WEIGHTS[reason] * 0.8` instead of running through the full scoring pipeline. Acceptable for v1.1 but should use real signals when algorithm V2 lands. (discovered in #408)
- **SuggestionRow client/server type duplication**: Client `SuggestionRow` interface in `discover.ts` manually mirrors the DB schema — any column addition requires two-place edit. Should derive from shared schema. (discovered in #408, pre-existing from #366)
- ~~**SuggestionReason enum duplicated across 8 files**~~: Resolved by #418 — shared registry extracted to `src/shared/schemas/discovery.ts`
- **discovery-weights.ts lacks dedicated unit tests**: `computeWeightMultipliers` formula edge cases (ratio exactly 0.8, sample size boundary at 4 vs 5) are only tested indirectly through discovery.service.test.ts integration. (discovered in #418, pre-existing from #406)
- **discovery.service.ts over max-lines (516 lines)**: File was already 452 lines before #406 (over the 400-line lint limit). Added eslint-disable but the service would benefit from extracting candidate query methods into a `discovery-candidates.ts` module. (discovered in #406, pre-existing from #407/#408)
