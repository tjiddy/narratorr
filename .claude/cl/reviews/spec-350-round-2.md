---
skill: respond-to-spec-review
issue: 350
round: 2
date: 2026-03-14
fixed_findings: [F4, F5]
---

### F4: Wrong method name for 5th call site
**What was caught:** M-9 AC and test plan referred to `cancelDownload` but the actual method is `DownloadService.cancel(id: number)`.
**Why I missed it:** When responding to F3 in round 1, I added the 5th call site reference using the colloquial name "cancelDownload" instead of reading the actual method signature at `download.service.ts:375`. The round-1 /respond-to-spec-review step 6 says "verify every factual claim your fixes introduce" but I didn't verify the method name against the source.
**Prompt fix:** Add to /respond-to-spec-review step 5, after determining disposition: "For `fixed` findings that introduce new symbol names (method, class, variable references), read the source file to confirm the exact name before writing it into the spec."

### F5: Test blast radius not documented
**What was caught:** Extracting the revert helper touches 4 existing test suites, but the spec didn't call that out.
**Why I missed it:** /elaborate's subagent reported existing test files but the test plan section didn't translate that into an explicit blast radius note for implementers. This is a gap in the /elaborate template — it collects test file info but doesn't require surfacing cross-file test update scope.
**Prompt fix:** Add to /elaborate step 4 (fill gaps): "For dedup/extraction changes, add a 'Test file blast radius' note listing all existing test files that will need coordinated updates when the shared helper is introduced."
