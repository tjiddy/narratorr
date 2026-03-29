---
skill: respond-to-pr-review
issue: 183
pr: 195
round: 1
date: 2026-03-29
fixed_findings: [F1, F2, F3, F4]
---

### F1: Card navigation test does not assert navigation
**What was caught:** Test only checked `role="link"` attribute, not that `navigate()` was called.
**Why I missed it:** Tried to avoid mocking react-router-dom (feared breaking MemoryRouter), so settled for a weaker assertion.
**Prompt fix:** Add to `/implement` testing guidance: "When testing navigation triggered by onClick, mock useNavigate and assert the exact path. Role attributes prove the element exists, not the behavior."

### F2: Import polling smoke test is vacuous
**What was caught:** Test only asserted books render, not that the polling hook fires.
**Why I missed it:** Avoided fake timers for simplicity, but that made the test assert nothing hook-specific.
**Prompt fix:** Add to `/implement` testing guidance: "Page-level smoke tests for hooks must assert an observable consequence of the hook running (API re-call, toast, state change). If removing the hook call wouldn't break the test, the test is vacuous."

### F3: Set-status tests don't prove label wiring
**What was caught:** Tests verified `api.updateBook` payload but not the `label` parameter that flows through to the toast.
**Why I missed it:** Focused on the API contract (status field) and forgot that the AC also covers the `label` wiring through the page to the mutation's success callback.
**Prompt fix:** Add to `/implement` testing guidance: "When a page-level wiring test covers a callback with multiple arguments (e.g., { status, label }), assert all arguments reach their destination — not just the one that hits the API."

### F4: Card menu transfer test too weak
**What was caught:** Counting menus (`toHaveLength(1)`) doesn't prove which card's menu is open.
**Why I missed it:** Assumed counting was sufficient since the menu component is identical across cards.
**Prompt fix:** Add to `/implement` testing guidance: "When testing state transfer between sibling elements (menu moves from card A to card B), assert the active-state attribute (aria-expanded) on both elements, not just count the visible instances."
