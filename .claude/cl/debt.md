# Technical Debt

- **CSP unsafe-inline**: `'unsafe-inline'` was added to scriptSrc in helmet config to allow the injected `window.__NARRATORR_URL_BASE__` config script. Consider using a nonce-based approach instead for stricter CSP. (discovered in #284)
- **registerStaticAndSpa untested**: The HTML injection and SPA fallback logic in `server-utils.ts` isn't unit tested because it requires a real filesystem with `dist/client/index.html`. An integration test with a temp directory would be more robust. (discovered in #284)
- **QualityGateService max-lines override**: File grew to 580 lines after adding `getQualityGateDataBatch()`. The SSE emission calls are mechanical boilerplate — consider extracting a helper. (discovered in #283, worsened in #356)
- **Activity/event-history routes still use string-matching error handling**: Routes match error messages via `message.includes('not found')` instead of typed error classes. (discovered in #359)
- **CredentialsSection lacks dedicated test file**: Tested indirectly through SecuritySettings integration tests only. (discovered in #358)
- **jobs/search.ts re-exports from search-pipeline**: Backward compat re-exports that can be cleaned up when all consumers import directly. (discovered in #357)
- **BookListService.getAll() slim select**: Explicit column list in `book-list.service.ts` must be kept in sync with schema. Consider deriving from full definition minus excluded. (discovered in #355, service renamed in #397)
- **jobs/index.test.ts hardcoded job count**: `toHaveLength(12)` will break every time a new job is added. (discovered in #366)
- **createMockServices hardcoded service names**: Service list in `helpers.ts` must be manually updated. (discovered in #366)
