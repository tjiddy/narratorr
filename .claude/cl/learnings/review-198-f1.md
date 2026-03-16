---
scope: [frontend, backend]
files: [src/shared/schemas/settings/processing.ts, src/shared/schemas/settings/registry.ts]
issue: 198
source: review
date: 2026-03-12
---
Reviewer caught that `stripDefaults()` makes `postProcessingScriptTimeout` required even when script path is empty — `valueAsNumber` returns NaN for cleared inputs, which fails `z.number()`. The fix required a custom `processingFormSchema` with `z.preprocess(nanToUndefined, ...)` and a conditional superRefine. Missed during implementation because I didn't test the form schema directly with NaN input. The `/plan` step should flag: "When adding optional numeric fields to settings, verify the form schema handles cleared inputs (NaN from valueAsNumber) correctly."
