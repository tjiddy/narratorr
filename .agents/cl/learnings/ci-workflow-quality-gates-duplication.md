---
scope: [scope/infra]
files: [.gitea/workflows/ci.yaml, .gitea/workflows/docker.yaml]
issue: 175
date: 2026-03-10
---
The Docker workflow duplicates the full quality-gates job from ci.yaml because Gitea Actions doesn't support reusable workflows across files like GitHub Actions does. This is intentional DRY violation — the alternative (a single workflow with conditional Docker job) would require the CI workflow to also trigger on tags, mixing concerns. Accept the duplication for now; if a third workflow appears, consider extracting a composite action.
