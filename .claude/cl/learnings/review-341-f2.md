---
scope: [scope/frontend]
files: [src/client/pages/settings/LibrarySettingsSection.tsx, src/client/pages/settings/ImportSettingsSection.tsx, src/client/pages/settings/QualitySettingsSection.tsx, src/client/pages/settings/NetworkSettingsSection.tsx, src/client/pages/settings/GeneralSettingsForm.tsx, src/client/pages/settings/MetadataSettingsForm.tsx, src/client/pages/settings/SearchSettingsSection.tsx, src/client/pages/settings/ProcessingSettingsSection.tsx]
issue: 341
source: review
date: 2026-03-12
---
Reviewer caught that zodResolver was missing from all 8 standalone settings forms. The original monolithic form used zodResolver via updateSettingsFormSchema — when splitting into per-section forms, each form needs its own zodResolver wired to an appropriate schema. Additionally, server-side schemas with `.default()` wrappers are incompatible with zodResolver's type constraints (input fields become optional, breaking `Resolver<FormData>`). Form-specific schemas must strip defaults. For cross-category forms (Search, Processing) that flatten fields from multiple categories, custom Zod schemas must be created to match the flat form shape.
