---
scope: [backend, frontend, core]
files: [src/shared/language-constants.ts, src/shared/schemas/settings/metadata.ts]
issue: 386
date: 2026-04-07
---
`z.enum()` requires an `as const` tuple (readonly with at least one element), not a plain `string[]`. When defining a canonical set of values shared between client and server, use `export const FOO = [...] as const` in `src/shared/`. This also enables deriving the element type: `type Foo = (typeof FOO)[number]`. Form schemas that use `z.array(z.string())` internally need a cast (`as CanonicalLanguage[]`) when passing to API types that expect the narrower enum type.
