---
skill: respond-to-pr-review
issue: 418
pr: 424
round: 1
date: 2026-03-17
fixed_findings: [F1]
---

### F1: Missing test for caller-provided weightMultipliers + strip-unknown behavior
**What was caught:** The dynamically-generated `weightMultipliersSchema` (built via `Object.fromEntries(SUGGESTION_REASONS...)`) had no test covering explicit caller-provided values or strip-unknown behavior — only defaults/omission were tested.
**Why I missed it:** When refactoring from static to dynamic schema derivation, I treated it as a transparent change and assumed existing default-path tests were sufficient. I didn't recognize that the derivation mechanism itself was a new behavior needing its own test — specifically, that the generated shape could be wrong (missing key) or the strip behavior could change without any test failing.
**Prompt fix:** Add to `/plan` test stub generation: "When a schema is refactored from static definition to dynamic derivation (e.g., `Object.fromEntries`, computed keys), always generate a test stub that exercises explicit caller-provided values including at least one unknown key — verifying both the generated shape and strip/passthrough behavior."
