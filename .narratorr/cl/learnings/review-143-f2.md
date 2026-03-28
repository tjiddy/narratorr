---
scope: [frontend]
files: [src/client/components/manual-import/ImportSummaryBar.tsx]
issue: 143
source: review
date: 2026-03-26
---
Making a prop optional to remove a dead call site broadens the contract for ALL callers. The correct pattern when a prop is conditionally required is a discriminated union keyed by the controlling flag: `{ hideMode: true; onModeChange?: never } | { hideMode?: false; onModeChange: (mode: ImportMode) => void }`. This enforces at the call site that the callback is required when the dropdown is visible and disallowed when it's hidden — not just "maybe there". Missed during implementation because the AC only said "make optional"; the reviewer caught the weaker contract.
