---
skill: respond-to-spec-review
issue: 393
round: 1
date: 2026-03-15
fixed_findings: [F1, F2, F3]
---

### F1: AC1 "ALL Drizzle methods" not falsifiable
**What was caught:** AC1 said "ALL Drizzle chainable query methods" which mixes a finite enumeration with "arbitrary future method names" — two different contracts with no defined boundary for special properties.
**Why I missed it:** The elaboration focused on expanding the test plan and implementation notes, not on tightening the AC language. "ALL" felt precise but is actually ambiguous when a Proxy handles arbitrary access — need to define what's excluded, not what's included.
**Prompt fix:** Add to `/elaborate` step 2 (Parse spec completeness): "For ACs that use 'all', 'every', or 'any' — verify the set is either enumerable or the AC defines the behavioral boundary (mechanism + exceptions). Flag 'all X' as imprecise if neither condition is met."

### F2: Rejection-path tests without configuration API
**What was caught:** Test plan required `.catch()` and `.finally()` behavior but the spec never defined how a test configures a rejected chain.
**Why I missed it:** The deep source analysis in `/elaborate` step 3 correctly identified the manual `.then` override workaround in book.service.test.ts, and test plan items were added for rejection paths. But the gap-fill only added test cases, not the AC for the API that enables those test cases. Test plan items were treated as self-contained rather than checked against ACs.
**Prompt fix:** Add to `/elaborate` step 4 (Fill gaps): "For every test plan item added during gap-fill, verify there is a matching AC that defines the API or behavior under test. If a test case requires a new API surface (e.g., error configuration), add an AC for that API — test cases without matching ACs are unimplementable."

### F3: Incomplete duplicate helper discovery
**What was caught:** Only one of three duplicate DB-chain helpers was identified in the implementation notes.
**Why I missed it:** The explore subagent searched for imports of `mockDbChain` but the other test files have inline re-implementations with different function names (local `mockDbChain` not imported, `makeChain`). Grep matched the import pattern but missed the copy-paste pattern.
**Prompt fix:** Add to `/elaborate` step 3 explore prompt item 9: "When checking for duplicate patterns to consolidate, grep for both the function name AND the implementation pattern (e.g., characteristic method names, structural patterns like thenable `.then` assignment). Inline re-implementations won't match import-based searches."
