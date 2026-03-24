---
scope: [frontend]
files: [src/client/pages/settings/SystemSettings.test.tsx]
issue: 66
date: 2026-03-24
---
When a page renders multiple independent forms each with a Save button, `screen.getByRole('button', { name: /save/i })` throws "multiple elements found". Target the form by finding a field unique to it: `screen.getByLabelText('Log Level').closest('form')` then `fireEvent.submit(form)`. This is more robust than `getAllByRole` index-guessing and more resilient to form order changes.
