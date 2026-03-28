---
scope: [frontend]
files: [src/client/pages/settings/BlacklistSettings.tsx]
issue: 271
date: 2026-03-09
---
Optimistic updates that toggle a type field must also handle derived fields correctly. When toggling permanent→temporary, `expiresAt` stays null until server response. If `formatExpiry()` checks `!expiresAt` to show "Permanent", the UI briefly shows wrong text. Fix: check the type field first (`blacklistType === 'permanent'`), then handle null expiresAt as a separate "Temporary" case.
