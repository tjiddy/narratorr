---
scope: [backend]
files: [src/server/routes/index.ts, src/server/routes/index.test.ts]
issue: 66
source: review
date: 2026-03-24
---
Startup wiring in createServices() (calling bootstrapProcessingDefaults with detectFfmpegPath) had no direct test — only the service method itself was tested in settings.service.test.ts. The wiring is a distinct integration point: it could be removed, wrong argument passed, or called in wrong order without any test catching it. Pattern: every new side-effect added to createServices() needs a direct test asserting the call happens with the correct argument. Testing the service in isolation is not sufficient. Mocking all service constructors with vi.fn() (regular function constructors for services that need method calls) makes createServices() testable.
