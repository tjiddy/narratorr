---
scope: [infra]
files: [scripts/merge.ts]
issue: 323
source: review
date: 2026-03-09
---
When removing old label logic (stage/fixes-pr on issue for merge conflicts), must add the equivalent on the new target (PR). The self-review didn't catch this because it focused on "is the code correct for what it does" rather than "is there a missing code path." Merge failure branches need both PR label update AND issue status sync.
