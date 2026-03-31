---
skill: respond-to-pr-review
issue: 257
pr: 268
round: 1
date: 2026-03-31
fixed_findings: [F1, F2, F3]
---
### F1: Activity page filter pills missing merge event types
**What was caught:** EVENT_TYPE_FILTERS hardcoded list in EventHistorySection.tsx doesn't include merge_started, merge_failed, merged
**Why I missed it:** Blast radius check during implementation didn't grep for all consumers of event type values beyond the shared schema and EventHistoryCard. The activity-page filter is a separate file that hardcodes its own list.
**Prompt fix:** Add to /implement step 4d (sibling enumeration): "When adding new event type enum values, grep for all hardcoded event type lists across the codebase (not just shared schemas — also filter dropdowns, pill arrays, and switch/case statements in UI components)."

### F2: useEventSource → useMergeProgress store transition untested
**What was caught:** The wiring between useEventSource and useMergeProgress store was untested — only individual behaviors (cache invalidation, toasts, store in isolation) were tested.
**Why I missed it:** The coverage review subagent identified this gap but it wasn't acted on because the useMergeProgress store tests were considered sufficient.
**Prompt fix:** Add to /handoff step 4 coverage review prompt: "When a hook writes to an external store (useSyncExternalStore pattern), the hook-level tests must include at least one integration test that mounts both the writing hook and the reading hook, simulates the event, and asserts the store state transition."

### F3: Merge button disabled state during SSE progress untested
**What was caught:** BookDetails test asserted progress indicator text but not button disabled state during merge progress.
**Why I missed it:** Test focused on the new UI element (progress indicator) rather than testing the behavioral interaction between progress state and existing button state.
**Prompt fix:** Add to testing standards: "When an existing interactive element (button, toggle) gains a new disabled condition from external state, always add a test asserting the disabled state directly — don't rely on tests of the state source (hook) or the visual indicator (text) as proxies."
