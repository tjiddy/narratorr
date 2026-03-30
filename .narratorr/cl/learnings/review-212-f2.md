---
scope: [scope/frontend]
files: [src/client/pages/settings/LibrarySettingsSection.tsx]
issue: 212
source: review
date: 2026-03-30
---
Reviewer caught that the isDirty guard was dropped from the useEffect that resets form state from settings query data. Without it, any queryKeys.settings() invalidation (e.g., from NamingSettingsSection saving) clobbers unsaved path edits. Root cause: when simplifying the form from full library form to path-only form, the `!isDirty` condition was accidentally removed from the useEffect. Prevention: when extracting code from a component, always compare the before/after of each useEffect and mutation hook — guards and conditions are the most fragile parts.
