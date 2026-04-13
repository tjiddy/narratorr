---
scope: [backend, frontend]
files: [src/server/services/discovery.service.ts, src/server/routes/discover.ts, src/client/pages/discover/DiscoverPage.tsx]
issue: 524
date: 2026-04-13
---
When removing a parallel pipeline (discovery addSuggestion → bookService.create), removing the method from the service cascades into removing constructor dependencies (bookService, eventHistory), which cascades into updating all callers (routes/index.ts wiring, test factories). Plan for 3 layers of cascade when removing service methods: (1) method removal, (2) unused dep removal, (3) caller/factory updates. TypeScript strict mode catches all three but only one at a time.
