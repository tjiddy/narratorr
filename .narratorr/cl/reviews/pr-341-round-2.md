---
skill: respond-to-pr-review
issue: 341
pr: 347
round: 2
date: 2026-03-12
fixed_findings: [F11, F12, F13, F14, F15, F16, F17, F18, F19]
---

### F11: Cross-section dirty-state test doesn't exercise save/refetch
**What was caught:** Test only checked values after dirtying, never triggered save + refetch cycle
**Why I missed it:** Treated the test as "assert values exist" rather than "exercise the interaction chain". Didn't think through what the isDirty guard actually protects against.
**Prompt fix:** Add to /implement: "When testing state-preservation guards (isDirty, stale data checks), the test MUST trigger the operation the guard protects against — not just set up the protected state."

### F12: Sentinel test doesn't use server-hydrated value
**What was caught:** Test typed sentinel into empty field instead of starting from server-returned masked value
**Why I missed it:** Took the path of least resistance (type into empty) rather than modeling the actual user flow
**Prompt fix:** Add to /plan test stubs: "For round-trip tests (server → form → save → server), seed the mock with the server-side value and verify it passes through unchanged."

### F13-F19: Missing invalid-submit tests for all zodResolver forms
**What was caught:** Added zodResolver to 7 forms but zero negative validation tests
**Why I missed it:** Focused entirely on making the positive tests (save success/error) work with zodResolver. Didn't treat validation addition as requiring its own test loop.
**Prompt fix:** Add to /implement: "Every zodResolver or validation schema addition MUST include at least one invalid-submit test per form that asserts: (1) error message renders, (2) API is NOT called. This is a 1:1 mapping — N forms with validation = N negative tests."
