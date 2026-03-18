---
name: spec
description: Create a new Gitea issue from the spec template. Use when user says
  "new issue", "create issue", "write a spec", or invokes /spec.
argument-hint: <title>
---

!`cat .claude/docs/design-principles.md`

!`cat .claude/docs/architecture-checks.md`

# /spec <title> — Create a Gitea issue from template

Draft a spec for a new issue using the spec template, then create it in Gitea.

## Gitea CLI

All Gitea commands use: `node scripts/gitea.ts` (referred to as `gitea` below).

## Steps

1. Read the spec template at `.claude/templates/spec.md`.
2. Ask the user to describe the feature/fix. If they already provided details in the conversation, use those.
3. Draft the spec body by filling in the template sections:
   - **Overview**: concise what/why
   - **User Interactions**: extract every meaningful interaction as "user does X → Y happens" — these become test stubs during `/claim`. Be specific about states and outcomes. Err on the side of too many interactions rather than too few.
   - **System Behaviors**: extract backend/service logic as "when X → Y happens" — these become backend test stubs during `/claim`. Skip if frontend-only.
   - **Acceptance Criteria**: verifiable behaviors, each mapping to one or more interactions/behaviors
   - **Technical Notes**: only if there are real constraints worth calling out
4. Present the draft to the user for review. Incorporate feedback.
5. Once approved, determine labels and milestone from context:
   - Type: `type/feature`, `type/bug`, or `type/chore`
   - Priority: `priority/high`, `priority/medium`, or `priority/low` (ask if unclear)
   - Scope: `scope/frontend`, `scope/backend`, `scope/core`, `scope/db` (can be multiple)
   - Status: `status/backlog` (default) or `status/ready` if user wants it next
6. Create the issue:
   ```
   gitea issue-create "<title>" --body-file <temp-file-path> "<labels>"
   ```
   Write the spec body to a temp file first, then pass via `--body-file`. Clean up the temp file after.
7. Display the created issue URL to the user.

## Quality Checks

Before presenting the draft, verify:
- Every interaction follows "user does X → Y happens" format
- Every system behavior follows "when X → Y happens" format
- No vague criteria like "works correctly" or "errors are handled"
- Each acceptance criterion maps to at least one interaction or behavior
- Interactions/behaviors cover error/edge states, not just happy path

## Architecture Design Check

**Reference:** `.claude/docs/architecture-checks.md`

Before presenting the draft, evaluate the spec against these design-level checks:

- **OCP-1 (Wiring Cost):** Does the spec describe adding a new variant to an existing type system (new adapter, new settings category, new notifier type)? If so, estimate how many files the implementation would touch just for type registration. If >3, flag it and suggest a registry pattern or note if one already exists.
- **LSP-1 (Interface Contract):** Does the spec describe an implementation that would return null/no-op where siblings return real data? Flag the contract violation and suggest a separate interface or explicit discriminator property.
- **OCP-2 (Growing Switch):** Does the spec describe adding a new case to an existing switch/factory? Note it and suggest checking if a registry pattern should be introduced.

If any check triggers, add a **Design Notes** section to the spec body (before Technical Notes) calling out the concern and the recommended approach. This shifts the conversation left — the implementer knows about the architectural constraint before writing code.
