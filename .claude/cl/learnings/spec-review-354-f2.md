---
scope: [scope/db]
files: []
issue: 354
source: spec-review
date: 2026-03-14
---
Spec cited `debt-scan-findings.md` as the source of truth for index findings, but that file doesn't exist in the repo. The `/elaborate` step carried forward the original issue's source reference without verifying the file exists. Fix: when a spec references an external document as evidence, verify the file is in the tracked repo before including the reference.
