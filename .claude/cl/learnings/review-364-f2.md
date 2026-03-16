---
scope: [frontend]
files: [src/client/pages/settings/ImportListsSettings.tsx]
issue: 364
source: review
date: 2026-03-14
---
When using useCrudSettings with ConfirmModal, the onConfirm handler must call setDeleteTarget(null) alongside deleteMutation.mutate(). The hook's deleteMutation.onSuccess does NOT clear deleteTarget — it only invalidates queries and shows a toast. All other settings pages (IndexersSettings, DownloadClientsSettings, NotificationsSettings, BlacklistSettings) follow this pattern. Missed it because I focused on replacing the manual mutations with the hook but didn't check how sibling pages wire the ConfirmModal.
