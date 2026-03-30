---
scope: [core, backend]
files: [src/shared/schemas/settings/library.ts]
issue: 212
date: 2026-03-30
---
Zod v4's internal type system (`$ZodTypeInternals`) makes generic refinement helpers tricky — `z.ZodType<string, z.ZodTypeDef, string>` doesn't satisfy `z.ZodTypeAny` constraints in object schemas. The pragmatic fix is to keep refinement calls inline but extract the shared validation functions (hasTitle, validateTokens) and error message constants, avoiding the need for generic schema wrappers altogether.
