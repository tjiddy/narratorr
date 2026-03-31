---
skill: respond-to-pr-review
issue: 238
pr: 249
round: 1
date: 2026-03-31
fixed_findings: [F1, F2, F3]
---

### F1: Missing redirect assertion after detail-page delete
**What was caught:** BookDetails delete tests never asserted the `navigate('/library')` call after successful deletion.
**Why I missed it:** The navigation was in a per-call `onSuccess` override on `deleteMutation.mutate()`, not in the hook's main `onSuccess`. I tested the hook-level behavior (API call, toast, invalidation) but didn't test the component-level side effect (redirect).
**Prompt fix:** Add to `/implement` step 4a test depth rule: "When a component uses a mutation's per-call `onSuccess`/`onError` overrides (not the hook-level callbacks), those overrides need dedicated component-level test assertions — they won't be caught by hook tests."

### F2: Missing cache invalidation assertion for new deleteMutation
**What was caught:** The deleteMutation test block didn't assert `queryClient.invalidateQueries` was called, even though sibling mutations in the same hook all had invalidation tests.
**Why I missed it:** I focused on the new behavior (API call mapping, toast messages) and didn't check the pattern of sibling mutations for consistency.
**Prompt fix:** Add to `/implement` step 4a test depth rule: "When adding a new mutation to an existing hook, check sibling mutations' test patterns and ensure the new mutation has matching coverage (invalidation, toast, error, etc.)."

### F3: Missing BookHero child-component contract tests
**What was caught:** New `onRemoveClick` and `isRemoving` props on BookHero were never tested at the child-component level — only through the parent BookDetails integration.
**Why I missed it:** I tested the full flow through BookDetails (click Remove → modal → confirm → API call) and assumed that covered the BookHero contract. But the child component is independently testable and should have its own callback + disabled state assertions.
**Prompt fix:** Add to `/implement` step 4d sibling enumeration: "When adding callback/state props to a child component, check the child's test file and add contract-level tests (callback forwarding, disabled state) — not just parent-level integration tests."
