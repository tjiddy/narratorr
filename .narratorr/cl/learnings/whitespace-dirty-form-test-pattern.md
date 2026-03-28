---
scope: [frontend, backend]
files: [src/client/pages/settings/LibrarySettingsSection.test.tsx]
issue: 145
date: 2026-03-26
---
Tests that use a single space ' ' to "dirty" a form field break when .trim() is added to the underlying Zod schema — the space trims to empty string, which now fails .min(1) with a different error ("required") instead of the intended refine error ("template must include {title}"). When dirtying a form to test validation, use a non-empty value that triggers the intended validation path (e.g., 'x' for a format field with token requirements) rather than whitespace.
