---
skill: respond-to-pr-review
issue: 57
pr: 61
round: 2
date: 2026-03-23
fixed_findings: [F1, F2]
---

### F1: searchAll drops indexerId before results reach activity join
**What was caught:** The new activity read path (DownloadService joins indexers table) only works for downloads that already have downloads.indexerId populated. The normal in-app search-grab flow never set that FK because searchAll() returned results with only `indexer: string`, not `indexerId`, and SearchReleasesModal.handleGrab() didn't pass indexerId even though the grab API already accepted it.

**Why I missed it:** The spec and test plan only described the read side — "add leftJoin to DownloadService, render in DownloadCard." The write side (FK population at grab time) wasn't in AC, implementation notes, or test plan. During implementation, I traced the queries but not the origin of the downloads.indexerId column. Self-review checked the DownloadCard rendering and service queries but didn't trace the full FK lifecycle: how does a download row get indexerId in the first place?

**Prompt fix:** Add to /implement step 4d (blast radius check): "For new FK joins on read paths, also verify the FK is populated on the write path. Ask: what creates this row? Does the creation code supply this FK? Grep for all insert/create calls on the table and verify the FK is passed."

### F2: No test proving indexerId round-trips from search result to grab request
**What was caught:** The existing grab test only asserted bookId was forwarded, not indexerId. So F1 could exist undetected even if a test ran.

**Why I missed it:** The test was written before F1 was identified — it tested the existing contract (bookId, downloadUrl, title) and didn't think about indexerId because it wasn't in the spec. The self-review coverage check said "grab test verifies args" but didn't check *which* args were verified against the contract.

**Prompt fix:** Add to /handoff step 4 (coverage review prompt): "For component tests that assert API call arguments, verify the assertion uses exact field enumeration or explicit field coverage — not just `expect.objectContaining` with a subset. If the API method accepts more fields than the test asserts, flag it as a coverage gap."
