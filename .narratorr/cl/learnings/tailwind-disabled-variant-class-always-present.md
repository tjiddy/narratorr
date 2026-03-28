---
scope: [frontend]
files: [src/client/pages/settings/ProcessingSettingsSection.tsx, src/client/pages/settings/ProcessingSettingsSection.test.tsx]
issue: 73
date: 2026-03-24
---
Tailwind `disabled:opacity-50` is always present in the DOM element's className regardless of disabled state — the CSS just only applies when the element has the `disabled` attribute. This means `toHaveClass('disabled:opacity-50')` passes even when the element is enabled, so you cannot test class removal. Use a conditional class like `${condition ? 'opacity-50' : ''}` if you need to assert class presence/absence, but this adds a ternary that can trigger complexity lint limits. The cleaner test is: assert `toHaveClass('disabled:opacity-50')` when disabled, and `not.toBeDisabled()` (not class removal) when re-enabled.
