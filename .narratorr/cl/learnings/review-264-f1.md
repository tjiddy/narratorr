---
scope: [frontend]
files: [src/client/components/settings/SettingsFormActions.test.tsx]
issue: 264
source: review
date: 2026-04-01
---
Reviewer caught that the create-mode Cancel button was untested under pending submit state (isPending=true). The test plan's edge case section mentioned "Cancel while create mutation is pending" but the implementation only added visibility and click tests for the normal state. When a new conditional branch is added (onCancel renders Cancel in create mode), tests should exercise the behavior under all relevant states — especially pending, since that's when users are most likely to want to cancel.
