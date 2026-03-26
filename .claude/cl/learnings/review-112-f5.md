---
scope: [scope/frontend, scope/db]
files: [src/client/pages/book/BookDetails.tsx, drizzle/0002_dapper_inhumans.sql]
issue: 112
source: review
date: 2026-03-26
---
The round-1 fix added `topLevelAudioFileCount` but used `?? audioFileCount` as a null fallback, meaning existing imported books with null `topLevelAudioFileCount` still showed the Merge button based on recursive `audioFileCount`. A legacy book with only nested audio files (all in disc subdirectories) would still show the button and then fail at the backend.

Why we missed it: adding a nullable column with a fallback felt like "backward compat", but it defeats the purpose of the eligibility check. The reviewer's AC requires hiding the button when eligibility cannot be confirmed, not just when it is explicitly false.

What would have prevented it: when adding a nullable DB column for a gate condition, the null handling in the UI gate should be pessimistic (hide = safe) not optimistic (fall back to old data = unsafe). Treat null as "unknown" → don't show action. Test should include "null → button hidden" as a required case.
