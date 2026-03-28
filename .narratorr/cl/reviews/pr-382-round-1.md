---
skill: respond-to-pr-review
issue: 382
pr: 386
round: 1
date: 2026-03-15
fixed_findings: [F1, F2]
---

### F1: Logout cookie missing env-dependent `secure` assertion
**What was caught:** The logout tests didn't prove the `secure: !config.isDev` attribute added to clearCookie — the default test env (isDev=true) meant `Secure` never appears, so removing `secure` wouldn't fail any test.
**Why I missed it:** I tested all visible attributes (HttpOnly, SameSite, Path) but didn't think about the env-dependent one that's invisible in dev mode. The "match test" compared login vs logout cookies but only checked the three always-present attributes.
**Prompt fix:** Add to `/implement` Phase 3 step 4a (Red — write failing tests): "For cookie/header tests, enumerate ALL attributes the code sets, including env-conditional ones. If an attribute depends on a config value, add paired tests exercising both branches of that config (e.g., isDev=true and isDev=false)."

### F2: Basic auth early-reject missing full response contract
**What was caught:** The early-reject tests only asserted 401 status + verifyCredentials not called, but didn't assert the www-authenticate header or response body. The new branch could return a different error and still pass.
**Why I missed it:** I followed the pattern of the existing "missing header returns 401" test which does assert www-authenticate, but the new tests I wrote focused on the "not called" assertion and only checked status code. I should have applied the same contract assertions as the existing auth tests.
**Prompt fix:** Add to `/implement` Phase 3 step 4a: "When adding new error/reject branches to routes, assert the full observable response contract: status code + relevant headers + response body shape. Match the assertion depth of existing sibling tests for the same endpoint."
