---
skill: respond-to-pr-review
issue: 272
pr: 280
round: 1
date: 2026-04-01
fixed_findings: [F1, F2]
---
### F1: Server-side indexer create/update still persist untrimmed settings
**What was caught:** Only the client-side form schema trimmed apiUrl/apiKey; the server CRUD schemas used `z.record()` and bypassed the trim.
**Why I missed it:** During implementation, I focused on the form schema (`createIndexerFormSchema`) where apiUrl/apiKey are explicitly typed fields, and didn't realize the server CRUD route uses different schemas (`createIndexerSchema`/`updateIndexerSchema`) with `z.record(z.string(), z.unknown())` for settings.
**Prompt fix:** Add to `/implement` step 4d (sibling enumeration): "When adding validation (trim, format, transform) to a schema field, grep for all schemas that handle the same data path. Zod form schemas and server CRUD schemas are often separate — verify both."

### F2: Quality settings UI missing preferredLanguage control
**What was caught:** `preferredLanguage` was added to schema/defaults/pipeline but never rendered in QualitySettingsSection.
**Why I missed it:** The issue scope labels were `scope/backend, scope/core` — I treated it as backend-only and skipped the settings UI component. The AC said "New preferredLanguage quality setting" which should have triggered UI work.
**Prompt fix:** Add to `/plan` step 5: "When adding a new settings field, check whether the settings section component renders a control for it. If the field is user-configurable (not internal-only), add a test stub for the UI control."
