---
scope: [frontend]
files: [src/shared/notifier-registry.ts, src/client/components/settings/NotifierCard.tsx]
issue: 371
date: 2026-04-06
---
When removing a parallel defaults map (like SETTINGS_DEFAULTS) in favor of registry-driven defaults, always diff ALL keys from the old map against ALL registry entries — not just the ones the spec calls out. The spec identified 3 missing fields but the actual gap was 5 (email's smtpUser/smtpPass were also missing). Running a programmatic diff upfront would have caught this immediately.
