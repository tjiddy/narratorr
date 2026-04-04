---
scope: [frontend]
files: [src/client/components/settings/IndexerCard.tsx, src/client/components/settings/IndexerCard.test.tsx]
issue: 339
source: review
date: 2026-04-04
---
When adding a conditional branch that injects data in one mode (edit) but not another (create), test BOTH sides: the positive case (edit includes `id`) AND the negative case (create does NOT include `id`). The coverage review caught the edit-mode assertion but missed the create-mode absence assertion. The existing create-mode test only checked `toHaveBeenCalled()` without asserting payload shape.
