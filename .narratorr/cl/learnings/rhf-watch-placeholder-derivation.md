---
scope: [frontend]
files: [src/client/components/settings/IndexerCard.tsx, src/client/components/settings/DownloadClientForm.tsx]
issue: 22
date: 2026-03-20
---
When a React Hook Form component already calls `watch('type')` for other purposes (e.g., resetting settings via `useEffect`), derived UI like placeholder text can read that same watched variable directly as a prop expression — no additional `useEffect`, `useState`, or memoization is needed. The re-render triggered by `watch` propagates the updated prop automatically.
