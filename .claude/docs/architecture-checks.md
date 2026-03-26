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

## Framework Checks

### Always Check

- **ZOD-1 — Untrimmed string validation.** Does a Zod string field use `.min(1)` without `.trim()` first? → `.trim().min(1)` — bare `.min(1)` accepts whitespace-only input.
- **TS-1 — Untyped catch.** Does a `catch` block leave the error untyped (`catch (e)`)? → Use `catch (error: unknown)` and narrow with `instanceof`.
- **CSS-1 — Z-index scale.** Does a new `z-` class break the hierarchy? → Scale: `z-10` sticky headers, `z-30` dropdowns, `z-40` popovers, `z-50` modals/overlays.

### Check When Applicable

- **REACT-1 — God hook.** Does a hook return >10 values or own 4+ mutations? → Split into focused hooks or group returns into named objects (`state`, `actions`, `counts`).
- **REACT-2 — Inline closures in render loops.** Are arrow functions created inside `.map()` that render components? → Extract to `useCallback`, use `React.memo` on the child, or pass stable callbacks with item ID.
- **ERR-1 — String-based error routing.** Does error handling branch on `message.includes('...')`? → Use typed error classes with a `code` field; catch by type, not by message text.
- **DB-1 — Late DB update after filesystem.** Does a DB write trail behind irreversible filesystem operations (rename, unlink)? → Update DB immediately after the first irreversible step, not at the end.

## How to Apply

- **`/spec`**: Check proposed design against OCP-1, OCP-2, DRY-1. Flag if the spec implies architecture that will require growing switches or 4+ file wiring.
- **`/plan`**: Verify the implementation plan doesn't introduce new violations. Check touch points against OCP-2.
- **`/review-pr`**: Grep for new switch/case, if-chains on type, parallel type definitions. Check framework rules (ZOD-1, TS-1, CSS-1, REACT-1/2, ERR-1, DB-1) against changed files. Flag violations as blocking findings.
- **`/review-spec`**: Check that acceptance criteria don't encode assumptions that violate these checks.
