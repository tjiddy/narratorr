---
scope: [frontend]
files: [src/client/pages/settings/NamingSettingsSection.tsx]
issue: 216
date: 2026-03-30
---
When removing a local component definition from a file, check whether the type imports it brought in (e.g., `ReactNode`) are still used by other code in the same file. Removing `type ReactNode` from the import line when `ReactNode` is still used in an interface definition causes a typecheck failure that only surfaces after build — tests pass fine since they don't run tsc.
