---
skill: respond-to-pr-review
issue: 263
pr: 271
round: 1
date: 2026-04-01
fixed_findings: [F1, F2]
---

### F1: Transactional create test only asserts call count, not row payload
**What was caught:** The `createWithMappings` test verified `txInsert` was called twice but never inspected the second insert's `.values()` payload to confirm it contained the correct `downloadClientId` and exact `remotePath`/`localPath` pairs.
**Why I missed it:** The `mockDbChain` helper makes call-count assertions easy but doesn't surface the `.values()` arguments automatically. I fell into the "assert invocation, not arguments" trap despite the testing standards explicitly warning against it.
**Prompt fix:** Add to `/implement` step 4a (red phase): "For DB insert/update tests using `mockDbChain`, override the `.values()` or `.set()` method on the chain mock to capture the payload, then assert the captured arguments match the expected row shape. `toHaveBeenCalledTimes(N)` alone is insufficient — it proves nothing about the data written."

### F2: Create-only field not tested through full page stack
**What was caught:** `pathMappings` was only proven at the form boundary (DownloadClientForm.test.tsx). No test verified the field survived the DownloadClientForm → DownloadClientCard → CrudSettingsPage → useCrudSettings → api.createClient chain.
**Why I missed it:** The coverage review subagent flagged the edit-mode submit gap but underweighted the page-level create flow. I assumed component-level + API-contract tests were sufficient.
**Prompt fix:** Add to `/implement` step 4d (sibling enumeration): "When a new field is added to a form payload that flows through a generic CRUD abstraction (e.g., `useCrudSettings`, `CrudSettingsPage`), always add a page-level interaction test in the parent settings page test file that exercises the full stack: render page → open form → fill field → submit → assert API mock receives field. Generic abstractions are the #1 place fields get silently dropped."
