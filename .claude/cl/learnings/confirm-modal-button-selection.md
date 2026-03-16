---
scope: [frontend]
files: [src/client/pages/settings/RecyclingBinSection.test.tsx]
issue: 331
date: 2026-03-10
---
When testing ConfirmModal buttons, accessible name matching (`getByRole('button', { name: /delete permanently/i })`) can be ambiguous when the modal's confirm label text overlaps with trigger button text. Use `dialog.querySelectorAll('button')[1]` to reliably select the confirm button (ConfirmModal renders Cancel first, Confirm second in DOM order due to flex-col-reverse layout). This is a pragmatic workaround — the alternative is ensuring every confirm label is globally unique, which isn't always practical.
