---
scope: [frontend]
files: [src/client/components/settings/formStyles.ts, src/client/components/settings/BlackholeFields.tsx, src/client/components/settings/DownloadClientFields.tsx]
issue: 289
date: 2026-04-01
---
When extracting shared style constants from multiple components, check for API divergence. `errorInputClass` was a static string in BlackholeFields/DownloadClientFields (used in ternary) but a function in NotifierFields. Extracting as a function (`errorInputClass(hasError: boolean)`) is the right approach, but requires updating ALL call sites from `condition ? errorInputClass : inputClass` to `errorInputClass(!!condition)`. Missing one produces a type error (string vs function return).
