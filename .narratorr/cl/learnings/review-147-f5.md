---
scope: [scope/backend]
files: [src/server/utils/post-processing-script.ts, src/server/utils/post-processing-script.test.ts]
issue: 147
source: review
date: 2026-03-27
---
The new non-Error access-failure fallback in runPostProcessingScript() had no test. The existing tests covered ENOENT and EACCES (both Error objects with code). The case where access() rejects a plain string or object was unexercised.

Why we missed it: The test plan for TS-1 only listed the ENOENT and EACCES cases as explicit test targets. The no-code fallback (code=undefined, getErrorMessage(error)='Unknown error') wasn't listed as a new behavior to test.

What would have prevented it: Same pattern as F1-F4. For every catch block that produces distinct outputs depending on error type, list all output variants in the test plan and add a test for each. The mixed .code/.message pattern (code === 'ENOENT' ? notFound : inaccessible with getErrorMessage fallback) produces 3 distinct outputs: not-found, EACCES (or other known code), and Unknown error. All 3 need tests.
