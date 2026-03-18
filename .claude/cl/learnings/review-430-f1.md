---
scope: [frontend]
files: [src/client/pages/settings/SettingsLayout.tsx, src/client/pages/settings/SettingsLayout.test.tsx]
issue: 430
source: review
date: 2026-03-18
---
Reviewer caught that the active-styling branch (isActive conditional class application) in SettingsLayout had no direct test. Tests only asserted href values, which don't exercise the path computation or end-flag logic that drives visual state. When refactoring a component to derive navigation from a registry, the active-state logic is a new branch that needs its own assertion — href tests alone can't catch regressions in active-tab highlighting.
