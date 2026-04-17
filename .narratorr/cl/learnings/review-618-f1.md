---
scope: [backend, services]
files: [src/server/services/import-orchestration.helpers.test.ts]
issue: 618
source: review
date: 2026-04-17
---
When an AC says "emit after DB write," tests must assert call ordering (invocationCallOrder), not just that both calls happened. Payload-only assertions are insufficient — they pass even if the emit moves before the write. Use `vi.fn().mock.invocationCallOrder` to prove sequencing.
