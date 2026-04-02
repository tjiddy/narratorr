---
scope: [frontend]
files: [src/client/pages/settings/ImportSettingsSection.tsx]
issue: 295
date: 2026-04-02
---
React Hook Form's `handleSubmit` strips values for fields registered with `register({ disabled: true })` (via `_names.disabled` set at `node_modules/react-hook-form/dist/index.esm.mjs:2062-2071`, unset loop at 2197-2200). However, an HTML `disabled` attribute set directly on the `<input>` element does NOT trigger this path — the value is preserved in submitted data. This distinction matters when you need a field to be visually disabled but still included in the payload. The `ProcessingSettingsSection` bitrate/keepOriginalBitrate pattern uses the safe HTML-disabled approach.
