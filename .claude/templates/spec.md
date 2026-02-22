# [Title]

## Overview

[1-3 sentences: what this feature/fix does and why it matters.]

## User Interactions

Describe every meaningful interaction as "user does X → Y happens." These become test cases during implementation.

- User [action] → [observable outcome]
- User [action] while [condition] → [different outcome]
- User [action] on [specific state] → [outcome including state change]

Examples of good interactions:
- User clicks Import with unmatched selections → button stays disabled, tooltip explains why
- User picks metadata on a no-match row → row promotes to Review, checkbox auto-selects
- User navigates away during matching → match job cancels

Examples of bad interactions (too vague):
- Import works correctly
- Errors are handled
- UI updates

## System Behaviors

Describe backend/service logic as "when X → Y happens." These become backend test cases during implementation.

- When [input/condition] → [system outcome]
- When [input/condition] and [edge case] → [different outcome]

Examples of good behaviors:
- When scan finds folder with 3 disc subfolders matching `/^(cd|disc)\s*\d+$/i` → merges into single book
- When provider returns 2 matches within 5% of scanned runtime → confidence is high
- When import fails after file copy → book status set to failed with error message

Examples of bad behaviors (too vague):
- Matching works correctly
- Errors are handled
- Data is validated

Skip this section if the feature is frontend-only.

## Acceptance Criteria

- [ ] [Criterion phrased as a verifiable behavior]
- [ ] [Each maps to one or more interactions above]

## Technical Notes

[Optional: constraints, API shapes, performance requirements, compatibility concerns. Delete this section if not needed.]
