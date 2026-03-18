---
skill: respond-to-spec-review
issue: 431
round: 1
date: 2026-03-17
fixed_findings: [F1, F2, F3, F4, F5, F6, F7, F8]
---

### F1: AC omits problem areas covered by test plan
**What was caught:** fireAndForget and internal-server-error helper had test plan sections but no AC items
**Why I missed it:** /elaborate generated the test plan after the AC was already written and didn't cross-check for coverage gaps
**Prompt fix:** Add to /elaborate step 4: "After generating test plan sections, verify every test plan section header maps to an AC item. If a test plan section exists without a corresponding AC, either add the AC or remove the test plan section."

### F2: Typed error AC too coarse
**What was caught:** "At least auth and library-scan use typed error classes" didn't enumerate branches or status codes
**Why I missed it:** Treated the AC as a high-level directive without reading the actual routes to count branches
**Prompt fix:** Add to /elaborate step 4 under durable content: "When AC references migrating error handling in specific files, enumerate every affected branch with file, line, exact string/pattern matched, and current HTTP status code."

### F3: Wrong HTTP status code for password error
**What was caught:** Test plan said InvalidPasswordError -> 401, but actual code uses 400
**Why I missed it:** Assumed password errors map to 401 Unauthorized without reading auth.test.ts assertions
**Prompt fix:** Add to /elaborate Explore subagent prompt (deep source analysis): "For error class migrations, read existing test files to verify the exact HTTP status codes asserted for each error path. Do not assume standard HTTP semantics -- the codebase may use different codes."

### F4: Monitor registry substitution changes behavior
**What was caught:** getInProgressStatuses() returns 7 statuses but monitor only needs 3
**Why I missed it:** Assumed the registry function was a drop-in replacement without reading what it returns
**Prompt fix:** Add to /elaborate Explore subagent prompt: "When the spec proposes replacing hardcoded values with a registry/helper function, read the function's return value and compare to the current hardcoded values. If they differ, the substitution changes behavior -- flag this."

### F5: Wrong notifier adapter count
**What was caught:** Said 7 adapters, but registry has 9 and only 6 have EVENT_TITLES
**Why I missed it:** Used the original issue's "5 duplicates" estimate and bumped to 7 without reading the registry
**Prompt fix:** Add to /elaborate Explore subagent prompt: "When the spec references counts of adapters/consumers/implementations, read the registry file and grep for the actual pattern to produce an exact count and explicit list."

### F6: Stale magic number inventory
**What was caught:** 60*60*1000 is fixed in 1 file, not 3; backup/rss are dynamic
**Why I missed it:** Trusted the original issue's inventory without grepping to verify each claim
**Prompt fix:** Add to /elaborate step 3 Explore prompt: "When the issue body lists specific code patterns with file locations, verify each one by grepping. Distinguish fixed constants from dynamic calculations. Report any discrepancies."

### F7: fetchWithTimeout scope too broad
**What was caught:** Indexer fetch helpers have specialized contracts, not simple timeout wrappers
**Why I missed it:** Treated all AbortController usage as equivalent without reading the full source of each call site
**Prompt fix:** Add to /elaborate Explore subagent prompt (deep source analysis): "When the spec proposes a shared utility to replace boilerplate, read the full source of every call site. Identify which have specialized contracts (custom return types, error wrapping, retry logic) that wouldn't fit a generic utility. Report these as scope exclusions."

### F8: getErrorMessage missing fallback parameter
**What was caught:** Routes use 12 different fallback strings, not just 'Unknown error'
**Why I missed it:** Only grepped for the pattern existence, didn't catalog the variation in fallback strings
**Prompt fix:** Add to /elaborate Explore subagent prompt: "When the spec proposes extracting a utility from duplicated code, grep for all instances and catalog the variation in arguments/parameters. If the pattern has variable parts, the utility signature must accommodate them."
