---
scope: [scope/frontend]
files: []
issue: 339
date: 2026-03-11
---
For large-scale mechanical test fixes (e.g., wrapping assertions in waitFor across 17 files), parallel background agents work well but need careful coordination. Some agents may appear stalled while their output files remain empty — check `git diff --stat` and re-read files directly to confirm completion. Also, prior context compactions can cause confusion about which files are done vs pending — always re-check `git diff --name-only` before continuing work.
