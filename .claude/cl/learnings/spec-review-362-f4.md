---
scope: [scope/frontend]
files: [src/client/components/icons.tsx]
issue: 362
source: spec-review
date: 2026-03-13
---
Reviewer caught that the spec said to replace `.animate-spin` with `getByRole('status')` but the production `LoadingSpinner` component has no `role`, `aria-label`, or `data-testid` — it's just a bare SVG. The spec assumed a queryable contract existed without checking. The fix: when AC says "replace X query with Y query", verify that the production component actually exposes a surface for query Y. If it doesn't, the spec must explicitly include the production component change.
