# Technical Debt

- **`src/server/utils/paths.ts` / `src/server/utils/import-helpers.ts`**: `extractYear()` is duplicated in both files — should be shared from one location (discovered in #210)
- **`src/client/pages/settings/LibrarySettingsSection.tsx`**: ~~At exactly 400 lines~~ **RESOLVED in #212** — reduced to ~105 lines after extracting NamingSettingsSection
- **`src/shared/schemas/settings/library.ts`**: Schema refinement chains (hasTitle + validateTokens) are still duplicated inline between folderFormatSchema/fileFormatSchema and libraryFormSchema because Zod v4's type system doesn't allow generic refinement wrapper functions that satisfy ZodObject shape constraints. Could be revisited if Zod v4 adds better type utilities (discovered in #212)
- **`src/shared/schemas/settings/strip-defaults.ts`**: `stripDefaults()` loses TypeScript field types — returns `z.ZodObject<Record<string, z.ZodType>>` instead of preserving the original shape. Categories needing `.pick()` or precise `z.infer` types must use explicit form schemas. A type-preserving `stripDefaults<T>()` generic would eliminate this duplication (discovered in #215)
- **`src/client/pages/settings/ProcessingSettingsSection.tsx`**: `as any` cast on zodResolver due to flattened cross-category form model + preprocess type divergence. Follow-up issue #219 created (discovered in #215)
