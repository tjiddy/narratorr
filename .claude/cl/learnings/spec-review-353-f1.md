---
scope: [infra]
files: []
issue: 353
source: spec-review
date: 2026-03-14
---
Spec included 3 findings (W-3, W-11, W-12) that were already addressed in current skill prompts. The /elaborate spec writer didn't verify current prompt state before writing AC items — assumed the debt scan findings were still valid without checking. Fix: before writing AC for prompt changes, read the actual skill file and confirm the delta still exists.
