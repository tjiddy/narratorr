---
skill: respond-to-pr-review
issue: 215
pr: 220
round: 1
date: 2026-03-30
fixed_findings: [F1, F2, F3, F4, F5, F6]
---

### F1-F3: Form schemas hand-copied instead of derived from settings schemas
**What was caught:** generalFormSchema, discoveryFormSchema, qualityFormSchema defined as manual z.object() copies instead of using stripDefaults() derivation.
**Why I missed it:** When stripDefaults() lost TypeScript types (ZodObject<Record<string, z.ZodType>>), I fell back to manual schemas instead of keeping the derivation with a type cast. The typecheck failure felt like a dead end.
**Prompt fix:** Add to /implement Phase 3 step 4: "When a runtime derivation utility loses TypeScript types, keep the derivation and add a type cast (`as z.ZodObject<{...}>`) rather than abandoning derivation for manual copies. The AC requires derivation, not just behavioral equivalence."

### F4: libraryFormSchema inline token messages
**What was caught:** Token-error messages in libraryFormSchema used inline strings instead of exported FOLDER_TOKEN_MSG/FILE_TOKEN_MSG constants.
**Why I missed it:** I updated the title messages to use constants but overlooked the token messages two lines below. Partial completion created a false sense of done.
**Prompt fix:** Add to /handoff self-review step 2: "For DRY-2 deduplication issues, grep the diff for ALL instances of each deduplicated string/pattern in the changed files. Partial deduplication (some instances replaced, others not) is a guaranteed review finding."

### F5: Author-advisory message still inline
**What was caught:** NamingSettingsSection "Consider including {author}" message remained as an inline string.
**Why I missed it:** I treated it as a UI advisory separate from validation messages, but the AC scope explicitly included it.
**Prompt fix:** Add to /implement Phase 3: "When an AC says 'replace inline message strings in <file>', enumerate ALL string literals in the target lines before implementing, not just the ones that match the schema validation pattern."

### F6: Missing page-level Discovery hidden-field test
**What was caught:** No page-level test asserting that DiscoverySettingsSection save omits weightMultipliers from the API payload.
**Why I missed it:** Schema-level tests in registry.test.ts covered the omission behavior, and I considered that sufficient. But the component's pickFormFields() helper and form submission path are separate from the schema.
**Prompt fix:** Add to /handoff coverage review prompt: "When a PR introduces a hidden-field exclusion or field-filtering behavior at the component level (pickFormFields, field mapping), verify a page-level test exists that asserts the exact save payload — schema tests alone don't cover the component wiring."
