---
name: changelog
description: Generate a categorized changelog from git history and linked GitHub issues.
  Use when user says "changelog", "release notes", or invokes /changelog.
argument-hint: "[since]"
model: haiku
---

# /changelog [since] — Generate a changelog

Run: `node scripts/changelog.ts $ARGUMENTS`

Display the output to the user. The script generates categorized markdown (Features, Bug Fixes, Chores, Other) from git commits and linked GitHub issues.
