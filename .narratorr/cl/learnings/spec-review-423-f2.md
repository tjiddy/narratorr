---
scope: [scope/backend]
files: []
issue: 423
source: spec-review
date: 2026-03-17
---
Reviewer caught that the helmet test uses a detached fixture (`prodOptions` hardcoded in the test) that had already drifted from the real production config in `index.ts`. The spec's test plan would have passed without proving the actual app wiring changed. Would have been caught by diffing the test fixture against the production config during spec writing, or by requiring shared config extraction upfront when a test's purpose is to validate production behavior.