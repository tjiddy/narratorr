---
scope: [frontend, backend]
files: [src/shared/schemas/auth.ts, src/client/pages/settings/CredentialsSection.tsx]
issue: 3
date: 2026-03-19
---
Password validation exists at both the HTML attribute layer (minLength on inputs) and the Zod schema layer (shared/schemas/auth.ts). The spec originally claimed "frontend-only" but backend schemas also enforced min(8). Always check both layers when changing validation constraints — the shared schemas in src/shared/schemas/ are the backend enforcement point, not just type definitions.
