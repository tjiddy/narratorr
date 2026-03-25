---
name: review-93-r2-f1
description: Clamp useEffect tests must cover both paginated sections (queue and history), not just one
scope: [scope/frontend]
files: [src/client/pages/activity/ActivityPage.test.tsx]
issue: 93
source: review
date: 2026-03-25
---
When a page has two independently paginated sections (queue and history in ActivityPage), a clamp `useEffect` test that exercises only one section leaves the other's wiring completely uncovered. The round-1 fix added a queue-side clamp test but omitted a history-side test; the reviewer caught it immediately.

**Why missed:** When writing the first clamp test, focus was on proving the core race-condition fix worked (queue side). The symmetrical history-side `useEffect` was not checked for test coverage after the fix.

**What would have prevented it:** After writing any section-specific integration test, scan the component for parallel sections/tabs/panels with the same wiring pattern and write a matching test for each. If `clampToTotal` is wired into a `useEffect` for both `queueTotal` and `historyTotal`, both need exercise.
