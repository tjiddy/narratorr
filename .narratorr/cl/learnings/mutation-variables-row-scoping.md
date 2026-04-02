---
scope: [frontend]
files: [src/client/pages/activity/ActivityPage.tsx, src/client/pages/activity/DownloadCard.tsx]
issue: 306
date: 2026-04-02
---
When a single TanStack Query mutation is shared across multiple list items (e.g., rejectMutation passed to every DownloadCard), `mutation.isPending` is true for ALL cards. Scope the spinner to the correct row by comparing `mutation.variables?.id` against the item's ID. For button-level scoping within a row, also compare additional fields (e.g., `variables?.retry` to distinguish Reject vs Reject & Search).
