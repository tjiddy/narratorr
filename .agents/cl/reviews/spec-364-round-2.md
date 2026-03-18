---
skill: respond-to-spec-review
issue: 364
round: 2
date: 2026-03-14
fixed_findings: [F1, F2]
---

### F1: M-24 context/grouped-props contradiction
**What was caught:** AC allowed "context or grouped prop objects" but also required "without LibraryToolbar acting as a prop pass-through" — which invalidates the grouped-props option.
**Why I missed it:** When fixing the round 1 finding, I combined both approaches into a single AC item and applied the no-pass-through constraint universally. Grouped props by definition still pass through the toolbar, just in a reduced form.
**Prompt fix:** Add to `/elaborate` step 4 durable content rules: "When AC offers multiple acceptable implementation approaches, verify each approach individually satisfies every constraint in the AC. If a constraint only applies to one approach, state it conditionally (e.g., 'if using context: no pass-through; if using grouped props: reduced surface')."

### F2: Duplicate-key collision without tie-break rule
**What was caught:** Test plan required "duplicate results with same asin render independently" but the key contract started with `asin ??`, meaning two same-ASIN results would produce identical keys.
**Why I missed it:** I added the duplicate test scenario in round 1 to address F3 (missing author-tab coverage) but didn't re-evaluate the key contract against the new collision test case. The test plan outpaced the AC.
**Prompt fix:** Add to `/elaborate` step 4: "After adding collision/duplicate test scenarios, re-verify the key contract against those scenarios. If a test asserts 'two items with the same X render uniquely,' the key contract must define how uniqueness is achieved when X collides."
