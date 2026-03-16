---
scope: [backend]
files: [src/server/jobs/monitor.test.ts]
issue: 279
source: review
date: 2026-03-10
---
Added progressUpdatedAt to the monitor's db.update().set() payload but existing tests only asserted db.update() was called (not what was set). The `chain.set` mock pattern from mockDbChain() allows asserting exact payloads — use it whenever adding fields to an update payload. Tests that only assert "update was called" catch nothing about the payload shape.
