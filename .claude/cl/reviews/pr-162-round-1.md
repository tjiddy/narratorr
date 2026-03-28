---
skill: respond-to-pr-review
issue: 162
pr: 170
round: 1
date: 2026-03-28
fixed_findings: [F1, F2, F3, F4]
---

### F1: Button form/aria-label forwarding untested
**What was caught:** The ...rest spread on Button was never exercised in tests — no test passed a non-standard attribute like form or aria-label and asserted it reached the DOM.
**Why I missed it:** Test plan focused on the component API surface (variant, size, icon, loading, disabled) without explicitly calling out the implicit ...rest contract. Spread forwarding is easy to assume works without verifying.
**Prompt fix:** Add to /plan and /implement checklists: when a component spreads ...rest onto a native element, the test plan must include an explicit test forwarding a non-standard attribute (form, aria-label, data-*) and asserting it reaches the element.

### F2: TestButton variant-to-size mapping untested
**What was caught:** TestButton maps variant=inline→size sm and variant=form→size md, but tests only checked behavior (click, disabled) without asserting the size class output.
**Why I missed it:** Focused on testing behavior contracts (onClick, disabled) of the wrapper rather than its transformation logic (variant→size mapping). Wrapper components that translate props need explicit tests for the translation.
**Prompt fix:** Add to /plan checklists: for wrapper components that map one prop value to another, include test assertions for the output value — not just the downstream behavior.

### F3: ConfirmModal destructive variant not asserted
**What was caught:** ConfirmModal migrated its confirm button to use variant=destructive, but tests only checked functional behavior (clicks callback, renders text). No test verified the destructive styling.
**Why I missed it:** When migrating callers to use Button, focused on ensuring functional tests still pass. Did not add variant-specific assertions for the migration target.
**Prompt fix:** Add to migration checklists: when migrating a caller to Button with variant=destructive, add a test asserting bg-destructive classes on the button. This is the most safety-critical visual contract.

### F4: Loading state test proved existence but not replacement
**What was caught:** The loading test asserted svg exists but did not prove the icon was replaced (vs supplemented). Both behaviors produce an svg.
**Why I missed it:** Wrote the test description as confirming replacement but the assertion was too weak to enforce it. Should have used the loading-spinner testid + count check from the start.
**Prompt fix:** Add to testing standards: when testing an icon-replacement behavior, assert (1) the replacement element is present via testid, and (2) the original icon is absent (or svg count is exactly 1). Existence of an svg does not prove replacement.
