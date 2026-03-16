---
scope: [scope/frontend, scope/backend]
files: []
issue: 198
source: spec-review
date: 2026-03-12
---
Spec didn't list the specific test files with hardcoded processing settings fixtures that would break when new fields are added. The settings blast radius pattern is well-documented in workflow history (issues #271, #332, #341) but the test plan didn't include a fixture update checklist. Test plans for schema changes should list affected fixture files so the implementer updates them intentionally.
