---
skill: respond-to-pr-review
issue: 174
pr: 180
round: 1
date: 2026-03-28
fixed_findings: [F1, F2]
---

### F1+F2: Redirect tests only assert message, not TransientError type

**What was caught:** The new redirect tests used rejects.toThrow(/redirect/i) which only asserts message content. They would still pass if the provider stopped wrapping the redirect Error into TransientError, because the message check does not verify the error type. MetadataService branches on instanceof TransientError, making the type contract load-bearing.

**Why I missed it:** When writing tests to distinguish redirect protection from MSW unhandled-request noise, I focused on the message content as the differentiator and did not separately assert the error type. The self-review checklist during /implement asks about AC keyword assertions but does not prompt for "assert both type AND message when testing error re-wrapping chains".

**Prompt fix:** Add to /implement step 4a (Red phase): "When testing that a catch block re-wraps errors (e.g., plain Error → TransientError), assert BOTH the error type (toBeInstanceOf) AND the message content. Asserting only the message does not verify the wrapping contract."
