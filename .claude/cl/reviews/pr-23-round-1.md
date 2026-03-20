---
skill: respond-to-pr-review
issue: 23
pr: 35
round: 1
date: 2026-03-20
fixed_findings: [F1, F2, F3]
---

### F1: Utility tests don't assert actionable guidance text
**What was caught:** The redirect test at line 76-81 only asserted the URL and `/auth proxy/i` — the "Use the service's internal address or whitelist this endpoint in your proxy config." clause was unprotected.
**Why I missed it:** During implementation I wrote assertions matching the spec's example message ("Server redirected to auth.tjiddy.com — an auth proxy may be intercepting...") but stopped at the category hint. I didn't map AC6 ("Error message is actionable: mentions using internal IP:port or whitelisting") to a specific assertion.
**Prompt fix:** Add to `/implement` Phase 3 (red/green step a): "For error message ACs, write one assertion per distinct clause the AC describes. If an AC lists multiple properties of the message (redirect URL, category hint, actionable advice), each must have its own assertion. Asserting the primary identifier alone does not pin the full contract."

### F2: NZBGet caller test incomplete for same reason as F1
**What was caught:** Same gap at the caller level — URL and auth-proxy present, guidance absent.
**Why I missed it:** Copy-paste from the utility test pattern carried the incomplete assertion set to the caller tests.
**Prompt fix:** Same as F1 — enforce per-clause assertions for error message ACs. The pattern fix at the utility level should be explicitly applied to all caller-level tests for the same message.

### F3: Slack test used send() instead of test()
**What was caught:** The spec said "notifier test() caller-level check" but the test called send(). Although test() delegates to send(), the AC explicitly names test() as the entry point.
**Why I missed it:** I reasoned that since test() delegates to send(), testing send() was equivalent. The reviewer correctly noted these are separate contract boundaries.
**Prompt fix:** Add to `/implement` Phase 3: "When an AC or spec names a specific method as the test entry point (e.g., 'notifier test() path'), the test must call that exact method — not a delegate it happens to call internally. Callers and their delegates are separate contract surfaces even when one is a thin wrapper around the other."
