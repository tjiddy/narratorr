---
scope: [scope/frontend]
files: []
issue: 264
source: spec-review
date: 2026-03-08
---
Reviewer caught that AC8 only mentioned "MAM ID input with help text" but didn't explicitly require the `baseUrl` field as a rendered/editable form input. In this codebase, `IndexerFields.tsx` renders fields explicitly per-type — there's no automatic form generation from the schema. When a settings field needs UI, the AC must explicitly call out each rendered field, not just the schema shape. The spec had `baseUrl` in User Interactions and Test Plan but not in the AC itself, creating an ambiguity gap. Fix: always enumerate every rendered form field in the AC for frontend components with per-field rendering patterns.
