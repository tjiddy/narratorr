---
scope: [frontend]
files: []
date: 2026-04-10
---
TanStack Query mutation functions receive 2 arguments: `(variables, context)`. `toHaveBeenCalledWith(expectedVars)` fails because of the extra context arg. Use `mock.calls[0][0]` to assert the variables directly, or `expect.objectContaining()` as the first arg with `expect.anything()` as the second.
