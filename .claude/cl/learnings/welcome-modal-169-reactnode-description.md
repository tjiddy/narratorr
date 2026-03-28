---
scope: [frontend]
files: [src/client/components/WelcomeModal.tsx]
issue: 169
date: 2026-03-28
---
To wrap inline text (e.g., "Settings → Security") in a `whitespace-nowrap` span within a card description, the `description` prop type must be `React.ReactNode` instead of `string`. A `string` prop cannot contain JSX; changing to `ReactNode` is backward compatible (existing string usages still work). When a spec says "wrap X in whitespace-nowrap", check whether the prop receiving the content accepts `ReactNode` — if not, the prop signature change is part of the implementation.
