---
scope: [core]
files: [src/core/metadata/audible.test.ts, src/core/metadata/audnexus.test.ts]
issue: 174
source: review
date: 2026-03-28
---
When testing that a provider re-wraps redirect errors as TransientError, asserting only on message content (rejects.toThrow(/redirect/i)) is insufficient — it does not prove the error type contract. Downstream MetadataService code branches on instanceof TransientError, so a plain Error leaking out would silently change behavior. Always assert both error type (toBeInstanceOf(TransientError)) and message content when the test is meant to verify the wrapping contract.
