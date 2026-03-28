---
scope: [infra]
files: []
issue: 285
date: 2026-03-11
---
Large 8-module TDD implementations (like import lists) reliably hit context compaction 1-2 times. The continuation summary must include exact file paths and the current module's incomplete steps. Without this, the resumed session wastes tokens re-reading files and re-discovering state. Committing after each module is critical — it provides git log as a recovery mechanism when context is lost.
