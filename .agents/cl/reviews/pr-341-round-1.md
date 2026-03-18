---
skill: respond-to-pr-review
issue: 341
pr: 347
round: 1
date: 2026-03-12
fixed_findings: [F1, F2, F3, F4, F5, F6, F7, F8, F9, F10]
---

### F1: Save button placement in multi-card form
**What was caught:** General section's save button rendered after both SettingsSection cards instead of inside one
**Why I missed it:** Focused on functionality (form submission works) not visual containment. The single-card sections had save inside the card by default, but the multi-card General form was different and I didn't audit the layout.
**Prompt fix:** Add to /plan or /implement frontend checklist: "When a form wraps multiple card/section components, verify the save button is visually contained inside the last card, not orphaned below."

### F2-F7, F10: Missing zodResolver on all standalone forms
**What was caught:** Every standalone form was missing zodResolver — no client-side schema validation
**Why I missed it:** The original monolithic form had zodResolver via the composed updateSettingsFormSchema. When splitting into per-section forms, I focused on the form mechanics (useForm, mutation, dirty state) and forgot to wire validation. Also didn't realize server schemas with `.default()` are incompatible with zodResolver's type constraints.
**Prompt fix:** Add to /implement: "When extracting a form from a larger form that used zodResolver, each extracted form MUST have its own zodResolver. Server schemas with `.default()` require a form-specific schema copy without defaults. Cross-category flat forms need custom schemas matching their flattened shape."

### F8: Missing cross-section dirty-state preservation test
**What was caught:** No test verifying the core architectural property — that dirty sections are preserved when other sections save
**Why I missed it:** Tests focused on individual section behavior (renders, submits, shows toast) but not the inter-section contract. The `!isDirty` guard in useEffect is the key mechanism that makes per-section forms safe, and it had no dedicated test.
**Prompt fix:** Add to /plan test planning: "When refactoring a monolithic component into independent sub-components, add at least one integration test that verifies the isolation property — that independent instances don't interfere with each other's state."

### F9: Missing proxy sentinel round-trip test
**What was caught:** No test for the `********` sentinel value passing through zodResolver validation
**Why I missed it:** Didn't inventory special-case validation logic in the schemas being wired to zodResolver. The sentinel passthrough in networkSettingsSchema is a non-obvious edge case.
**Prompt fix:** Add to /implement: "When wiring zodResolver to a schema, review the schema for special-case validation (transforms, refinements, sentinel values) and add a test for each edge case."
