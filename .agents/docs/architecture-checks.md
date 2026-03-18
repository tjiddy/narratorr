# Architecture Checks

Greppable SOLID and DRY checks run by `/spec`, `/plan`, `/review-pr`, and `/review-spec` at appropriate stages.

## Always Check

- **OCP-1 — Growing switch/map.** Does adding a new variant (adapter, notifier, indexer type) require editing a switch/case, if-chain, or growing map in existing code? → Needs a registry or plugin pattern.
- **OCP-2 — Wiring cost.** Does adding a new feature type require coordinated edits across 4+ existing files? → Architecture should allow extension via new files, not modification of existing ones.
- **DRY-1 — Parallel types.** Is the same type/enum/union defined in multiple places that must be kept in sync manually? → Single source of truth, derive the rest.

## Check When Applicable

- **SRP-1 — Mixed concerns.** Does a single file/component handle more than one axis of change (e.g., indexer settings AND download client settings in the same component)? → Split by concern.
- **LSP-1 — Interface contract.** Does a new adapter/implementation satisfy the full interface contract, including error cases and edge behaviors? → Verify against the interface type, not just the happy path.
- **ISP-1 — Fat interface.** Does an interface force implementers to provide methods they don't use? → Split into smaller, role-specific interfaces.

## How to Apply

- **`/spec`**: Check proposed design against OCP-1, OCP-2, DRY-1. Flag if the spec implies architecture that will require growing switches or 4+ file wiring.
- **`/plan`**: Verify the implementation plan doesn't introduce new violations. Check touch points against OCP-2.
- **`/review-pr`**: Grep for new switch/case, if-chains on type, parallel type definitions. Flag violations as blocking findings.
- **`/review-spec`**: Check that acceptance criteria don't encode assumptions that violate these checks.
