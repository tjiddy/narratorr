---
skill: respond-to-spec-review
issue: 382
round: 1
date: 2026-03-15
fixed_findings: [F1, F2, F3, F4, F5]
---

### F1: CSP unsafe-inline removal would break URL_BASE injection
**What was caught:** Removing `'unsafe-inline'` from production CSP would regress the inline `<script>` tag that injects `window.__NARRATORR_URL_BASE__` in `server-utils.ts:20`.
**Why I missed it:** `/elaborate` explored the CSP config but didn't trace what code currently depends on `'unsafe-inline'`. The scope boundaries section even said "if that breaks the injected script, nonce support becomes a follow-up" — acknowledging the risk but still including the fix in scope.
**Prompt fix:** Add to `/elaborate` step 3 codebase exploration: "For any AC that removes a security relaxation (CSP directive, CORS origin, auth bypass), trace all code paths that currently depend on the relaxed setting. If removing it would break existing functionality, flag as a dependency that must be resolved first or defer the fix."

### F2: AC only required tests for Basic auth, not all 5 changed areas
**What was caught:** AC7 said "new/updated tests cover Basic auth edge cases" but 5 other security surfaces were also being changed without explicit test requirements.
**Why I missed it:** The test plan was comprehensive (covered all areas), but the AC was written to match the original spec's emphasis rather than the test plan. Disconnect between test plan completeness and AC enforceability.
**Prompt fix:** Add to `/elaborate` step 4 gap-fill: "When filling a test plan, verify that the AC explicitly requires tests for every area the test plan covers. If the AC only mentions a subset, expand the AC to match."

### F3: VACUUM INTO charset whitelist not Windows-portable
**What was caught:** The fallback validation note (alphanumeric + hyphens + dots + path separators) would reject Windows paths with drive-letter colons and spaces.
**Why I missed it:** Assumed Unix-style paths when writing the validation rule. Didn't check `config.configPath` construction to see it could be a Windows absolute path.
**Prompt fix:** Add to `/elaborate` step 3 deep source analysis: "For any path validation rule, check whether the path can be a Windows absolute path (drive letter colon, spaces, UNC). Cross-reference `config.ts` for path construction."

### F4: Script failure logging test assigned to wrong layer
**What was caught:** Test plan said ScriptNotifier "logs error without crashing" but it returns results — callers log.
**Why I missed it:** Didn't re-read the adapter to confirm its return contract vs logging behavior, despite CLAUDE.md saying core adapters don't log.
**Prompt fix:** No prompt change needed — CLAUDE.md already says "Core adapters: do NOT log — throw errors or return failures; calling service logs." The `/elaborate` subagent should have caught this from the existing convention. This is a reminder to follow existing conventions, not a prompt gap.

### F5: Ambiguous Basic auth edge case outcomes
**What was caught:** "Empty username → 401 or accepted" and "malformed base64 → returns 401" were ambiguous or described implementation details rather than observable contracts.
**Why I missed it:** Hedged on edge case outcomes instead of making a decision. The "or 401 if rejected" phrasing was added as a safety valve instead of reading the code to determine the right behavior.
**Prompt fix:** Add to `/elaborate` step 4 test plan gap-fill: "Every test case must have exactly one expected outcome. If the outcome depends on an implementation decision not yet made, state the decision explicitly in the AC or technical notes — do not hedge with 'or' alternatives."
