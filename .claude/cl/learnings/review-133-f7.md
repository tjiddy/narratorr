---
scope: [frontend]
files: [src/client/components/manual-import/ImportSummaryBar.tsx]
issue: 133
source: review
date: 2026-03-26
---
When a component adds a custom label prop to override static text, override ALL occurrences of that text — including the pending/loading state branch. A component that uses a custom registerLabel for the idle state but reverts to hardcoded "Importing..." in the pending state produces inconsistent copy and defeats the purpose of the override. Apply label overrides to every branch that renders the same text.
