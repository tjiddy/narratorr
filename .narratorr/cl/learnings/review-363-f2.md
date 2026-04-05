---
scope: [frontend]
files: [src/client/components/settings/IndexerCard.test.tsx]
issue: 363
source: review
date: 2026-04-05
---
Reviewer caught that the new searchType dropdown was tested for render/hydration but not through the actual form submit path. A DOM value assertion (`dropdown.value === 'nVIP'`) doesn't prove the value reaches `onSubmit` — it could be unregistered with react-hook-form. Always test new form fields through the full submit flow: change value → click save → assert payload contains the field. This is the "test the mutation lifecycle" standard.
