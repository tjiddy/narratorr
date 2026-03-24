---
scope: [frontend]
files: [src/client/pages/discover/DiscoverySettingsSection.tsx, src/client/pages/settings/ProcessingSettingsSection.tsx]
issue: 73
date: 2026-03-24
---
The `after:absolute` on the slider toggle dot pseudo-element must have a `relative` positioned ancestor to position against. Two valid approaches exist in the codebase: (1) standard pattern — `relative` on the outer `<label className="relative inline-flex ...">` (used in ProcessingSettingsSection, SearchSettingsSection); (2) compact pattern — `relative` on the track `<div>` itself (used in ImportListsSettings). When the outer label has complex layout (justify-between with description text), use a separate `<label className="relative inline-flex...">` wrapping just the input+div, with `htmlFor` on the text label pointing to the input id.
