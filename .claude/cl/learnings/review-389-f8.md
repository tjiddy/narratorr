---
scope: [scope/frontend]
files: [src/client/pages/activity/EventHistorySection.test.tsx]
issue: 389
source: review
date: 2026-03-15
---
Reviewer caught that the activity-page delete button test only asserted presence (`getByLabelText('Delete event')`) without exercising the click → `deleteMutation.mutate(id)` wiring. The book-page equivalent (F5) was fixed in round 1, but the symmetrical gap in EventHistorySection was missed.

Missed because: when fixing F5 (BookEventHistory delete wiring), we didn't check the sibling page (EventHistorySection) for the same gap. The existing presence-only test felt sufficient since the component-level test (F4) covered the click behavior.

Prevention: the sibling pattern check should be applied not just to production code but also to test fixes — when upgrading a test from presence to interaction in one page, grep for the same presence-only pattern in sibling pages and upgrade them all.
