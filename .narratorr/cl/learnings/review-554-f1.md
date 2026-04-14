---
scope: [backend]
files: [src/server/services/import.service.ts]
issue: 554
source: review
date: 2026-04-14
---
Moving an eager status guard into a transaction that runs after long filesystem ops opens a race window where concurrent scheduler passes can re-admit the same download. Status transitions that prevent re-admission must remain eager (before the slow phase), even when wrapping other mutations in a transaction. The spec said "inside transaction" for all three status writes, but the importing guard serves a different purpose (concurrency protection) than the book+imported writes (atomicity).
