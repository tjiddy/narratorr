---
scope: [backend, frontend, db]
files: [src/server/routes/index.ts, src/server/services/index.ts, src/server/jobs/index.ts, src/server/plugins/error-handler.ts]
issue: 238
date: 2026-03-31
---
Removing a full feature subsystem (service + routes + jobs + settings + UI) touches far more files than the primary source files. The blast radius includes: route wiring (Services interface, SERVICE_KEYS, createServices return, routeRegistry entry), service barrel export, job registry entry, error handler mapping, settings schema + registry defaults + form component, API client barrel + query keys, and ~12 test files with fixtures/mocks. The grep sweep (`grep -ri "term" src/`) is the only reliable cleanup check — the spec's bullet list will always miss something (e.g., error-handler.ts was missing from the original spec).
