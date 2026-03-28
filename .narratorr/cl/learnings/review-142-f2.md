---
scope: [scope/frontend]
files: [src/client/pages/manual-import/ManualImportPage.test.tsx]
issue: 142
source: review
date: 2026-03-26
---
When fixing vacuous negative-only `waitFor` blocks, sweep the entire test file — not just the enumerated list from the spec AC. The outside→inside state-transition test was adjacent to the five fixed guardrail tests and used the same vacuous pattern, but the issue spec only listed the original five. The fix pattern is identical: add `expect(await screen.findByDisplayValue('<typed path>')).toBeInTheDocument()` before the negative assertion to ensure the state has actually settled.
