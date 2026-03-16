---
scope: [scope/backend]
files: []
issue: 366
source: spec-review
date: 2026-03-16
---
Reviewer caught that issue comment 7071 added a requirement for a discovery toggle controlling nav visibility, but the spec body never incorporated it. Gap: `/elaborate` reads the issue body but apparently didn't integrate the issue comments into the spec. The elaborate step should check issue comments for additional requirements and ensure they're reflected in the AC and settings sections.
