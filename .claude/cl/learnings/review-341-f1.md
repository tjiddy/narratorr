---
scope: [scope/frontend]
files: [src/client/pages/settings/GeneralSettingsForm.tsx]
issue: 341
source: review
date: 2026-03-12
---
Reviewer caught that the General section's save button was rendered outside both SettingsSection cards (after the closing tags), creating a visually orphaned button. When a form wraps multiple card-style sections, the save button should be inside the last card to maintain visual containment. Missed because the F1 finding wasn't about functionality but layout consistency — the original pattern placed the button after the form's children, which works for single-card sections but breaks for multi-card forms.
