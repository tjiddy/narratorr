---
scope: [scope/frontend]
files: [src/client/pages/settings/SecuritySettings.tsx, src/client/pages/settings/SecuritySettings.test.tsx]
issue: 8
source: review
date: 2026-03-19
---
Child component tests (CredentialsSection) cannot prove that the parent (SecuritySettings) correctly wires query data into props, or that invalidation-driven re-renders produce the correct UI transition. When a parent passes a reactive prop from a query into a child, add a page-level test that: (1) resolves the initial query, (2) triggers the mutation, (3) resolves the refetch to the post-action state, and (4) asserts the resulting UI. This is the only layer that catches prop-wiring and invalidation-rerender bugs.
