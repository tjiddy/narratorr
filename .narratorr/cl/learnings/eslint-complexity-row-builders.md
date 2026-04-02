---
scope: [frontend]
files: [src/client/pages/activity/QualityComparisonPanel.tsx]
issue: 300
date: 2026-04-02
---
Adding conditional rows to a `buildRows()` function quickly hits the ESLint complexity limit (15). Each `if (field !== null)` branch counts. The fix: extract each row into a focused helper returning `Row | null`, then filter nulls in `buildRows()`. This keeps the main function as a declarative pipeline and each helper at complexity 1-2.
