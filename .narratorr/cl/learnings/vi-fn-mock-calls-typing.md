---
scope: [frontend]
files: [src/client/pages/settings/CrudSettingsPage.test.tsx]
issue: 186
date: 2026-03-28
---
`vi.fn().mock.calls[N][M]` has strict tuple typing that breaks typecheck when the mock has no typed signature. Accessing captured call arguments via `mock.calls` indices triggers TS2493 ("Tuple type '[]' has no element at index '0'"). Fix: capture arguments inside the mock function body (`vi.fn((item, handlers) => { captured.push({ item, handlers }); return null; })`) instead of reading `.mock.calls` after the fact.
