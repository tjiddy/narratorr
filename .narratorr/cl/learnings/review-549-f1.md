---
scope: [frontend]
files: [src/client/hooks/useClickOutside.ts, src/client/hooks/useClickOutside.test.ts]
issue: 549
source: review
date: 2026-04-14
---
The null-ref case in useClickOutside was implemented opposite to the spec. When all refs are null (unmounted), the hook should no-op — not treat the click as "outside." The test even commented "no-ops" while asserting the handler fires. Root cause: the spec said "no-ops when ref.current is null" but the implementation treated null refs as having no containment, which logically means "outside everything." The test was written to match the implementation rather than the spec. Prevention: always re-read the spec test plan before writing test assertions, and verify negative tests actually match the intended behavior contract.
