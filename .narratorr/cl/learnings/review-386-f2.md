---
scope: [backend]
files: [src/server/services/settings.service.ts]
issue: 386
source: review
date: 2026-04-07
---
When migrating a free-text field to an enum-validated field, always normalize AND validate against the target enum before writing. Raw toLowerCase() is insufficient — ISO codes ('eng'), abbreviations ('en'), and misspellings won't match the enum and will poison the row, causing Zod parse failures that silently reset all settings in that category. Use normalizeLanguage() + CANONICAL_LANGUAGES check as a gate.
