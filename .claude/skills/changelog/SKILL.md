---
name: changelog
description: Generate a categorized changelog from git history and linked Gitea issues.
  Use when user says "changelog", "release notes", or invokes /changelog.
argument-hint: "[since]"
model: haiku
---

# /changelog [since] — Generate a changelog from git history

Read-only skill that generates a categorized changelog from git commits and linked Gitea issues. Runs as an Explore subagent.

## Gitea CLI

All Gitea commands use: `node scripts/gitea.ts` (referred to as `gitea` below).

## Arguments

- `$ARGUMENTS` — optional git ref or tag to start from (default: last tag, or last 20 commits if no tags)

## Steps

1. **Determine the `since` ref:**
   - If `$ARGUMENTS` is provided, use it as the start ref
   - Otherwise, find the last tag: `git describe --tags --abbrev=0 2>/dev/null`
   - If no tags exist, use `HEAD~20` as fallback

2. **Get commits:** `git log --oneline <since>..HEAD`

3. **Extract issue references:** Find all `#<id>` patterns in commit messages, deduplicate.

4. **Fetch issue details:** For each unique issue ID, run `gitea issue <id>` to get:
   - Title
   - Type label (`type/feature`, `type/bug`, `type/chore`)

5. **Generate changelog markdown:**
   ```markdown
   # Changelog

   ## Features
   - #<id> <title>

   ## Bug Fixes
   - #<id> <title>

   ## Chores
   - #<id> <title>

   ## Other
   - <commits without issue refs, one-line each>
   ```

6. **Report the changelog** to the user.

## Important

- This skill is **read-only** — does not write files, create tags, or modify anything
- Commits without `#<id>` references go in the "Other" section
- If an issue ID can't be fetched (deleted, private), use the commit message instead
- Keep it concise — one line per issue/commit
