---
skill: respond-to-pr-review
issue: 18
pr: 55
round: 1
date: 2026-03-21
fixed_findings: [F1, F2]
---

### F1: Successful path-only autosave never clears path from RHF dirty state

**What was caught:** After blur autosave, `resetField` was not called, so `isDirty` stayed true for the path field. The Save button continued rendering even though the path was already persisted.

**Why I missed it:** The spec said "sibling fields unaffected by blur-save" but never stated the inverse — that the path field itself should become non-dirty after autosave. I focused on partial payload correctness (`{ library: { path } }` only) and cache update, but didn't think through the RHF dirty state lifecycle. The `setQueryData` approach was chosen to avoid sibling-field reset, but that only affects the query cache, not RHF's field defaults.

**Prompt fix:** Add to `/implement` Phase 3 step 4: "When implementing a partial save that auto-saves one field from a multi-field form, verify the saved field's RHF dirty state is cleared. Call `resetField(fieldName, { defaultValue: savedValue })` so the Save button only reflects remaining unsaved fields."

### F2: Settings-page rescan omits books-query invalidation present in existing rescan path

**What was caught:** The new `rescanMutation.onSuccess` only showed a toast, omitting `queryClient.invalidateQueries({ queryKey: queryKeys.books() })` that the equivalent mutation in `useLibraryMutations.ts` already includes.

**Why I missed it:** When creating a new mutation that calls an existing API, I checked the API signature and return type but did not cross-reference the onSuccess side effects of existing callers of the same API. The test plan from the spec only mentioned "success toast shown" — it didn't say anything about cache invalidation.

**Prompt fix:** Add to `/implement` Phase 3 step 4b (Sibling enumeration): "When adding a new useMutation that calls an API method already used elsewhere in the codebase, grep for all existing callers and check their onSuccess handlers. Copy all cache invalidation calls — not just the happy-path toast."
