---
scope: [scope/backend]
files: [src/server/plugins/auth.ts]
issue: 333
source: spec-review
date: 2026-03-10
---
Spec described a new private endpoint as "auth required, returns 401 without credentials" — but this codebase has a `mode === 'none'` auth bypass where all private routes pass through unchallenged. The spec (and test plan) encoded an unconditional 401 expectation that doesn't hold in all auth modes. When specifying auth behavior for new endpoints, reference the auth plugin's actual model (mode-dependent enforcement, local bypass) instead of assuming blanket 401.
