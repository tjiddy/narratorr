---
scope: [scope/frontend, scope/api]
files: [src/client/components/settings/IndexerCard.tsx, src/client/components/settings/DownloadClientForm.tsx]
issue: 315
source: spec-review
date: 2026-03-11
---
Spec proposed API response masking but left the edit-form data flow as "TBD in planning." The reviewer correctly flagged this as unimplementable — edit forms hydrate from GET responses, so masking reads breaks edit mode unless a concrete replacement contract is specified. Lesson: never defer a data-flow contract to planning when the AC depends on it. If masking reads, trace the full read→UI→write cycle and specify the edit contract in the same AC.
