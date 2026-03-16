---
scope: [scope/backend, scope/services]
files: []
issue: 355
source: spec-review
date: 2026-03-13
---
When a spec cites a source file by name (e.g., `debt-scan-findings.md`), verify the file actually exists in the repo before publishing. The citation format `filename — IDs` implies a repo artifact. If the source is external context (conversation output, analysis tool, etc.), say so explicitly: "External debt scan analysis (not a repo artifact)."
