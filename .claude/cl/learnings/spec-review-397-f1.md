---
scope: [scope/services, scope/backend]
files: []
issue: 397
source: spec-review
date: 2026-03-15
---
Spec review caught that AC5 (wiring) only named the obvious direct callers (books routes, search/rss jobs) but missed indirect callers: manual task routes in system.ts, job scheduler registration in jobs/index.ts, the Services interface, createServices(), and the barrel export. For refactors that change a service's public surface, the spec must trace ALL callers — not just the ones that call extracted methods directly, but also the wiring/registration layer that passes the service around. A grep for the service name across the codebase would have caught this.
