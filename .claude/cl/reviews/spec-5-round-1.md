---
skill: respond-to-spec-review
issue: 5
round: 1
date: 2026-03-19
fixed_findings: [F1]
---

### F1: Nonexistent frontend file path in Technical Notes
**What was caught:** Technical Notes referenced `src/client/pages/settings/components/CredentialsSection.tsx` but the file lives at `src/client/pages/settings/CredentialsSection.tsx`.
**Why I missed it:** The spec was written referencing the component by assumed path without verifying against `git ls-files` or the filesystem. The `components/` subdirectory exists in some settings pages but not all.
**Prompt fix:** Add to `/spec` Technical Notes section: "Before including file paths in Technical Notes, verify each path exists with `git ls-files <path>`. Do not assume subdirectory structure from similar pages."
