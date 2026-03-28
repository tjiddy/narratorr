---
skill: respond-to-pr-review
issue: 198
pr: 348
round: 1
date: 2026-03-12
fixed_findings: [F1, F2, F3, F4, F5, F6]
---

### F1: Timeout validation unconditional even when script disabled
**What was caught:** Form schema rejects cleared timeout (NaN) even when script path is empty, contradicting the AC that says validation only applies when a script is configured.
**Why I missed it:** Didn't test the form schema with NaN input from `valueAsNumber`. Relied on `stripDefaults()` mechanical derivation without considering that numeric fields cleared in the browser produce NaN, not undefined.
**Prompt fix:** Add to `/plan` step "Schema module": "When adding optional numeric settings fields, verify that the form schema handles cleared browser inputs (NaN from valueAsNumber). If the field should only be required conditionally, create a custom formSchema with z.preprocess to convert NaN to undefined, and add conditional validation in the superRefine."

### F2+F3: Missing page-level save and validation tests
**What was caught:** Tests only covered render/prefill/typing — no test proved the fields appear in the submitted payload or that validation errors surface on submit.
**Why I missed it:** Focused TDD on the component's render behavior and didn't include a save-flow test. The existing tests for other processing fields also don't have save-flow tests, so I followed the (inadequate) existing pattern.
**Prompt fix:** Add to `/implement` frontend test checklist: "For every new settings field, include: (1) save round-trip test (type value → submit → assert api.updateSettings payload), (2) validation error test (trigger error condition → submit → assert error message visible + API not called)."

### F4: Missing import pipeline ordering test
**What was caught:** Tests verified the script hook fires with correct args but not that it runs after tag embedding and before markImported. Moving the hook would not break any test.
**Why I missed it:** Focused on the "does it work" tests (args, skip, error handling) without a "does it run in the right place" test. The AC explicitly mentions ordering but I didn't translate that to an ordering assertion.
**Prompt fix:** Add to `/implement` backend test checklist: "When an AC specifies execution order ('runs after X and before Y'), add an ordering test that records call sequence via mock implementations and asserts the expected order."

### F5: Missing log.warn assertions for ENOENT/timeout
**What was caught:** Tests asserted the returned warning string but not the `log.warn()` side effect. If logging were removed, tests would still pass.
**Why I missed it:** The existing non-zero-exit test had a `mockLog.warn` assertion, but I didn't replicate it for ENOENT and timeout branches. Inconsistent coverage across error branches.
**Prompt fix:** Add to `/implement` test quality checklist: "When AC says 'logged as warning,' assert `mockLog.warn` with expected structured payload — not just the return value. Every log.warn/log.error call in new code must have a matching test assertion."

### F6: Missing schema boundary tests
**What was caught:** Only the default snapshot was tested — `.min(1)` and `.int()` constraints had no boundary tests.
**Why I missed it:** Treated the schema field addition as a simple default test. Didn't add negative tests for the constraints.
**Prompt fix:** Add to `/implement` schema test checklist: "For every Zod constraint (.min, .max, .int, .email, etc.), add boundary tests: value at boundary (accepted/rejected), value just past boundary (opposite disposition), type violation."
