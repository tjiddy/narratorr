---
scope: [scope/frontend]
files: [apps/narratorr/src/client/components/settings/DownloadClientCard.tsx]
issue: 197
source: review
date: 2026-02-24
---
Reviewer caught that urlBase was only normalized in the adapter constructors (runtime), not on save. The persisted value kept raw user input (slashes, whitespace), so the UI showed unnormalized values after save. Fix: normalize in the form submit handler before the mutation fires. When adding fields that require normalization, normalize at the persistence boundary (form submit), not just the consumption boundary (adapter constructor).
