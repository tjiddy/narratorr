---
scope: [scope/frontend]
files: []
issue: 164
source: spec-review
date: 2026-02-22
---
Spec said `htmlFor` can match input `id` or `name`, but HTML label association only works via `id`. The `name` attribute is for form submission, not label binding. This slipped through because the elaborate phase focused on identifying which labels need fixing rather than verifying the HTML spec for the association mechanism itself. Prevention: when writing specs about HTML/DOM behavior, verify the actual DOM API contract rather than relying on common developer assumptions.
