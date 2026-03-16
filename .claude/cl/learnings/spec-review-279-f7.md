---
scope: [scope/frontend]
files: [src/client/App.tsx, src/client/pages/settings/SettingsLayout.tsx]
issue: 279
source: spec-review
date: 2026-03-10
---
AC said "System page accessible from Settings navigation" implying a new route/nav item, but `/settings/system` already exists. Specs expanding existing pages should say "expand" not "add" to avoid unnecessary route creation work and potential conflicts with existing navigation.
