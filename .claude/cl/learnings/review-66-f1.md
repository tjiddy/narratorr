---
scope: [frontend]
files: [src/client/pages/settings/GeneralSettings.tsx, src/client/pages/settings/GeneralSettings.test.tsx]
issue: 66
source: review
date: 2026-03-24
---
When relocating a component from one settings tab to another, the source tab must have the component REMOVED — not just have the destination tab added. This was a spec gap: the issue described adding GeneralSettingsForm to System, but didn't explicitly state "remove it from General" as a discrete step. Self-review missed it because GeneralSettings.tsx was "changing" (ProcessingSettingsSection removed) and looked done. Pattern: when a spec says "move X to Y", always verify the source page removes X explicitly. The paired test still asserting Housekeeping/Logging were present on General locked the regression in.
