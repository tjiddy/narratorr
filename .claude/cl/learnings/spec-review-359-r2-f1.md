---
scope: [scope/backend, scope/services]
files: [src/server/routes/event-history.ts, src/server/services/event-history.service.ts]
issue: 359
source: spec-review
date: 2026-03-14
---
Round 2 review caught that the M-11 error-mapping contract listed `'not in a retriable state'` as the event-history 400 case, but the actual route checks `message.includes('does not support') || message.includes('no associated') || message.includes('no info hash')`. Root cause: when fixing F2 in round 1, I read the activity.ts error patterns carefully but paraphrased the event-history patterns from memory instead of reading event-history.ts:72 directly. Would have been prevented by reading every route file listed in the error-mapping contract table and copying exact string patterns.
