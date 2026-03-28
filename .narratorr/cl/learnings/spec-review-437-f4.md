---
scope: [scope/backend, scope/core]
files: [src/core/utils/constants.ts, src/core/metadata/audible.ts, src/core/metadata/audnexus.ts]
issue: 437
source: spec-review
date: 2026-03-18
---
Reviewer caught that the timeout-constant AC was ambiguous — said "defined once" but the test plan only named 2 of 7+ hardcoded timeout locations, and didn't acknowledge that constants.ts already exists with DEFAULT_REQUEST_TIMEOUT_MS and NOTIFIER_TIMEOUT_MS. The values also vary intentionally (10s/15s/30s), not uniformly 15s as originally stated. Root cause: grep for hardcoded timeouts was incomplete, and the spec assumed a uniform value without checking. Prevention: for constant-extraction specs, grep all instances, note their values, and explicitly scope which ones to extract vs leave as-is.
