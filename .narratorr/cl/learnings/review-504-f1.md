---
scope: [backend]
files: [src/server/services/import-orchestrator.test.ts]
issue: 504
source: review
date: 2026-04-12
---
When the issue is specifically about fixing a guid-only usenet path, the test fixture MUST include a guid-only variant (infoHash: null, guid: present). The default fixture had infoHash set, so the guid propagation was never actually proven. Always create a fixture matching the exact scenario the issue describes.
