---
scope: [scope/frontend]
files: []
issue: 339
date: 2026-03-11
---
Not every bare assertion after a waitFor block is flaky. The spec's target matchers (`toBeDisabled`, `toHaveValue`, `toBeChecked`, `toHaveTextContent`, `toHaveClass`) are the ones that depend on async React state reconciliation. `toBeInTheDocument` after a nearby waitFor that confirmed the same render pass is generally safe. AuthorPage.test.tsx had ~7 estimated instances but zero of the target matchers — the count was inflated by `toBeInTheDocument` assertions that don't actually race.
