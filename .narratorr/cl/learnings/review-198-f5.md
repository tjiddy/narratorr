---
scope: [backend]
files: [src/server/utils/post-processing-script.test.ts]
issue: 198
source: review
date: 2026-03-12
---
Reviewer caught that return-value-only assertions don't prove logging side effects. If `log.warn()` calls were removed, the tests would still pass. When AC says "logged as warning," the test must assert `mockLog.warn` with expected payload (scriptPath, timeoutSeconds, etc.), not just the return value.
