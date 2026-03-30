---
scope: [frontend]
files: [src/client/components/settings/DownloadClientForm.tsx, src/client/components/settings/IndexerCard.tsx, src/client/components/settings/NotifierCardForm.tsx]
issue: 224
date: 2026-03-30
---
When migrating raw selects to SelectWithChevron, the label styling changes from the consumer's `text-sm font-medium mb-2` to SelectWithChevron's built-in `text-xs font-medium text-muted-foreground mb-1`. This is intentional for consistency but means the label will look slightly different after migration. Remove the old `<label>` and `<div>` wrapper entirely — SelectWithChevron renders its own label via the `label` prop.
