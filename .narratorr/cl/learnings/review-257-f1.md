---
scope: [frontend]
files: [src/client/pages/activity/EventHistorySection.tsx]
issue: 257
source: review
date: 2026-03-31
---
When adding new event types to the event-history schema, the activity-page filter pills in `EventHistorySection.tsx` use a hardcoded `EVENT_TYPE_FILTERS` array that must be updated manually. The spec AC mentioned "filter dropdown accepts merge_started and merge_failed" but the implementation missed this file because it's not in the same module as EventHistoryCard. Blast radius check during implementation should have grepped for all consumers of eventTypeSchema values.
