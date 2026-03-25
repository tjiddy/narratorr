---
scope: [backend, frontend]
files: [src/shared/schemas/settings/import.ts, src/shared/schemas/settings/registry.ts]
issue: 118
date: 2026-03-25
---
Adding a `z.boolean().default(true)` field to a Zod schema makes the field **required in the TypeScript output type** (`z.infer<typeof schema>`), even though it is optional in the input type. Any test that passes an explicit object to `settings.set('import', {...})` without the new field will produce a TS2345 error. The blast radius is larger than just `toEqual` assertions — it includes every `settings.set()` call that constructs the full import object inline. Run `pnpm typecheck` directly (not via `verify.ts`) to see all errors at once before fixing them one by one.
