---
scope: [scope/infra]
files: [.gitea/workflows/ci.yaml]
issue: 175
source: spec-review
date: 2026-03-10
---
Multi-arch build AC didn't specify how arm64 images would actually be built — QEMU emulation, native runners, or buildx cross-compilation. The existing CI workflow only shows a generic runner label. When speccing CI/CD tasks that target multiple architectures, always define the build strategy explicitly (toolchain actions, runner prerequisites) rather than just stating the desired output.
