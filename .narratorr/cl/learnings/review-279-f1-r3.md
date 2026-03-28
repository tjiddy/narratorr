---
scope: [frontend]
files: [src/client/pages/settings/ScheduledTasks.test.tsx]
issue: 279
source: review
date: 2026-03-10
---
When a component has a ternary swapping between two icons based on mutation state (e.g., `isPending ? <Spinner /> : <IdleIcon />`), the pending-state test must assert BOTH the disabled state AND the spinner rendering. Asserting only `disabled` proves the button is inert but doesn't prove the visual feedback changed. Query the spinner by its distinguishing characteristic (e.g., `svg.animate-spin`) within the button element.
