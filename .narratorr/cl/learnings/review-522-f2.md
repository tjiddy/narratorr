---
scope: [backend]
files: [src/shared/constants.ts, src/shared/constants.test.ts]
issue: 522
source: review
date: 2026-04-13
---
When extracting a constant and updating both production code and test fixtures to import it, test fixtures that derive size values from the same constant create a circular dependency — if the constant drifts, both production and tests drift together and still pass. New shared constants need an independent source-of-truth test that asserts the literal value (e.g., `BYTES_PER_GB === 1024 * 1024 * 1024`).
