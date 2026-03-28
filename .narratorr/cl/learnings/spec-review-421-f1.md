---
scope: [scope/backend]
files: []
issue: 421
source: spec-review
date: 2026-03-17
---
AC2 said "derive service names dynamically" but never identified the runtime source of truth — `Services` is a TS interface (erased at runtime) and the only concrete object is an inline return in `createServices()`. The spec assumed dynamic derivation was self-evidently implementable without naming the mechanism. Should have checked whether the interface had a runtime counterpart before writing the AC, and if not, explicitly specified what artifact to introduce (e.g., `SERVICE_KEYS` const array).
