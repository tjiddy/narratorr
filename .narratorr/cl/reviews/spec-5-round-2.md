---
skill: respond-to-spec-review
issue: 5
round: 2
date: 2026-03-19
fixed_findings: [F4]
---

### F4: Wrong HTTP method for password-change route in test plan
**What was caught:** Route-level test plan said `POST /api/auth/password` but the actual route is `PUT /api/auth/password`.
**Why I missed it:** When adding F3's route-level test items in round 1, I assumed POST for both endpoints without checking the route registration. The setup endpoint is POST but the password-change endpoint is PUT.
**Prompt fix:** Add to `/respond-to-spec-review` step 6 (verify fixes): "When adding route-level test plan items, verify the HTTP method by grepping the route file — do not assume POST for all mutation endpoints."
