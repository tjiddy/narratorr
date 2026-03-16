---
scope: [scope/services]
files: []
issue: 349
source: spec-review
date: 2026-03-15
---
The optional-service AC said "missing services skip silently with debug log" but the actual logging behavior varies: broadcaster failures log at `debug`, notifier/event-history rejections log at `warn`. The `/elaborate` subagent noted optional chaining but didn't read the log levels at each call site. When writing AC about error/skip behavior for optional collaborators, check the actual log level at each call site rather than assuming a uniform level.
