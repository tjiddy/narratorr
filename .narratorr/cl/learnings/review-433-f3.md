---
scope: [scope/backend, scope/services]
files: [src/server/services/metadata.service.test.ts]
issue: 433
source: review
date: 2026-03-17
---
Reviewer caught that the TransientError contract verification tests only asserted fallback return values but not the log.warn side effect. The service contract includes both "return fallback" and "log warning" behaviors — testing only one half leaves the other unguarded. Missed because tests were focused on proving the new TransientError classification didn't change caller-visible return values. Prevention: when a catch block has two side effects (return fallback + log), assert both. Logging is part of the observable contract for service-level error handling.
