---
scope: [scope/frontend, scope/ui]
files: [src/client/App.tsx, src/client/components/layout/Layout.tsx]
issue: 280
source: spec-review
date: 2026-03-10
---
Spec referenced a "System page" that doesn't exist in the app. The elaboration step didn't verify that the UI destination actually existed — it assumed a System page was either present or trivially addable without specifying it in scope. Preventable by checking `App.tsx` routes and `Layout.tsx` nav items during elaboration and either naming the exact destination or adding it to scope explicitly.
