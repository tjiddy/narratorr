# Architecture Checks

Greppable SOLID and DRY checks. `/spec` (narratorr) applies these when creating a new issue. Workflume's `/review-spec` and `/review-pr` skills pull this doc in at dispatch time and enforce each applicable check.

## Always Check

- **OCP-1 — Growing switch/map.** Does adding a new variant (adapter, notifier, indexer type) require editing a switch/case, if-chain, or growing map in existing code? → Needs a registry or plugin pattern.
- **OCP-2 — Wiring cost.** Does adding a new feature type require coordinated edits across 4+ existing files? → Architecture should allow extension via new files, not modification of existing ones.
- **DRY-1 — Parallel types.** Is the same type/enum/union defined in multiple places that must be kept in sync manually? → Single source of truth, derive the rest.
- **DRY-2 — Duplicated logic.** Does the same function body, regex, or validation logic appear in 2+ files? → Single canonical definition, import everywhere else. When an AC says "share" or "extract," grep the diff for same-shape logic that was copied instead of imported. Small helpers and regexes count.

## Check When Applicable

- **SRP-1 — Mixed concerns.** Does a single file/component handle more than one axis of change (e.g., indexer settings AND download client settings in the same component)? → Split by concern.
- **LSP-1 — Interface contract.** Does a new adapter/implementation satisfy the full interface contract, including error cases and edge behaviors? → Verify against the interface type, not just the happy path.
- **ISP-1 — Fat interface.** Does an interface force implementers to provide methods they don't use? → Split into smaller, role-specific interfaces.

## Framework Checks

### Always Check

- **ZOD-1 — Untrimmed string validation.** Does a Zod string field use `.min(1)` without `.trim()` first? → `.trim().min(1)` — bare `.min(1)` accepts whitespace-only input.
- **ZOD-2 — Schema copy instead of composition.** Does the diff define a new Zod schema with the same field names as an existing one? → Use `.pick()`, `.omit()`, or `.extend()` on the canonical schema. Copying fields by hand means refine chains, defaults, and transforms drift independently.
- **TS-1 — Untyped catch.** Does a `catch` block leave the error untyped (`catch (e)`)? → Use `catch (error: unknown)` and narrow with `instanceof`.
- **CSS-1 — Z-index scale.** Does a new `z-` class break the hierarchy? → Scale: `z-10` sticky headers, `z-30` dropdowns, `z-40` popovers, `z-50` modals/overlays.

### Check When Applicable

- **REACT-1 — God hook.** Does a hook return >10 values or own 4+ mutations? → Split into focused hooks or group returns into named objects (`state`, `actions`, `counts`).
- **REACT-2 — Inline closures in render loops.** Are arrow functions created inside `.map()` that render components? → Extract to `useCallback`, use `React.memo` on the child, or pass stable callbacks with item ID.
- **REACT-3 — Local form primitive.** Does the diff introduce a styled input, select, textarea, or form control component scoped to a single file? → Search `src/client/components/` and sibling settings sections for equivalent patterns. If another consumer exists (or should), extract to a shared component. Form primitives are the canonical case for shared components.
- **REACT-4 — useEffect as event handler.** Does a `useEffect` run logic that belongs in a callback (`onClick`, `onSubmit`, `onBlur`, mutation `onSuccess`)? → Effects are for synchronization with external systems, not for "do X when Y happens." Move the logic to the event handler or mutation callback.
- **REACT-5 — Missing error boundary.** Does a new page or major section component lack an error boundary? → A crash in one section shouldn't white-screen the whole app. Wrap pages and independently-failing sections with error boundaries.
- **ERR-1 — String-based error routing.** Does error handling branch on `message.includes('...')`? → Use typed error classes with a `code` field; catch by type, not by message text.
- **TS-2 — Loose any/as casts.** Does production code use `as any`, `as unknown as X`, or `Record<string, any>`? → Find the real type. `as Mock` and `as never` in tests are acceptable; `as any` in `src/` is not. If the type is genuinely unknowable, use `unknown` and narrow.
- **DB-1 — Late DB update after filesystem.** Does a DB write trail behind irreversible filesystem operations (rename, unlink)? → Update DB immediately after the first irreversible step, not at the end.
- **DB-2 — Multi-step mutation without transaction.** Do sequential `db.insert()` / `db.update()` / `db.delete()` calls across tables happen outside a `db.transaction()`? → Wrap in a transaction so a failure mid-sequence doesn't leave partial state.

## How to Apply

- **`/spec`** (narratorr): Check proposed design against OCP-1, OCP-2, DRY-1. Flag if the spec implies architecture that will require growing switches or 4+ file wiring.
- **`/review-pr`** (workflume): Grep for new switch/case, if-chains on type, parallel type definitions. Check framework rules (ZOD-1, TS-1/2, CSS-1, REACT-1/2/3/4/5, ERR-1, DB-1) against changed files. For every new helper/component/regex in the diff, grep unchanged files for equivalent patterns (DRY-2). Code-cleanup ACs (extract, share, deduplicate) require the same verification rigor as behavioral ACs — "it works" is insufficient when the spec says "share." Flag violations as blocking findings.
- **`/review-spec`** (workflume): Check that acceptance criteria don't encode assumptions that violate these checks.
