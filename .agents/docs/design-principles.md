# Design Principles

- **Single responsibility.** Each file, component, and service should have one reason to change. If modifying indexer settings requires editing the same file as download client settings, that's an SRP violation — split them. A long file that does one thing well is fine; a short file that mixes concerns is not.
- **Don't repeat yourself.** If three CRUD sections share identical mutation/query/toast patterns, extract a shared hook or component. Duplication is a stronger signal than file length.
- **Open for extension, closed for modification.** Adding a new feature (adapter, settings section, notifier type) should mean creating new files, not modifying a growing list in existing ones. If wiring a feature requires touching 4+ existing files, the architecture needs a registry/plugin pattern.
- **Co-locate what changes together.** Types live alongside their API methods. Components live with their hooks. Tests live next to their source. Barrel `index.ts` at module boundaries, direct imports within.
- **Extract components and hooks, not just functions.** When a component grows a second concern, extract it to its own file — don't just extract a helper function within the same file. React components and hooks are the unit of reuse.

**Mechanical checks:** See `.claude/docs/architecture-checks.md` for greppable SOLID and DRY checks.
