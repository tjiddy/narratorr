---
scope: [scope/frontend]
files: [src/client/pages/settings/LibrarySettingsSection.tsx]
issue: 212
source: review
date: 2026-03-30
---
Reviewer caught that the inline Scan Library action was removed entirely instead of being relocated next to the Library Path label. The AC said "Library section reduced to: Library Path input (Browse + Scan Library inline) → Bulk Operations" — the "Scan Library inline" part was missed during extraction. Root cause: when extracting naming UI from LibrarySettingsSection, the standalone Scan Library link was correctly removed but the replacement inline action next to the label wasn't added. Prevention: when an AC says "reduced to X + Y + Z", verify each element is present in the reduced component, not just that removed elements are gone.
