---
scope: [scope/frontend]
files: [src/client/pages/settings/SystemSettings.tsx]
issue: 280
source: review
date: 2026-03-10
---
The restore confirmation modal said "the server will restart" without distinguishing between supervised (Docker, systemd) and unsupervised (bare node) deployments. The spec explicitly required this distinction. Root cause: modal text was written generically without checking the spec's exact wording requirement. Prevention: for user-facing warning text, always cross-reference the spec's exact phrasing requirements.
