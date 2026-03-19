---
name: setup-labels
description: Bootstrap all required workflow labels in GitHub. Safe to re-run — skips
  existing labels. Use when user says "setup labels", "create labels", or invokes
  /setup-labels.
disable-model-invocation: true
---

# /setup-labels — Create workflow labels in GitHub

Bootstrap all required workflow labels (status, stage, type, priority) in the GitHub repo. Safe to re-run — skips labels that already exist.

## Steps

1. Run: `node scripts/setup-labels.ts`
2. Display the full output to the user
