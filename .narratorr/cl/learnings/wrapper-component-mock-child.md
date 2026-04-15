---
scope: [frontend]
files: [src/client/pages/manual-import/PathStep.tsx]
issue: 562
date: 2026-04-15
---
When testing wrapper-specific prop forwarding (e.g., PathStep forwards libraryPath as fallbackBrowsePath to PathInput), render the real child and mock only the API boundary. For fallbackBrowsePath, the observable effect is that `api.browseDirectory` is called with the forwarded path when the Browse modal opens — test by clicking Browse and asserting on the mock. This follows the project standard of API-boundary mocking while proving the real integration path works.
