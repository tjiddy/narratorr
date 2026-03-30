# Technical Debt

- **`src/server/utils/paths.ts` / `src/server/utils/import-helpers.ts`**: `extractYear()` is duplicated in both files — should be shared from one location (discovered in #210)
- **`src/client/pages/settings/LibrarySettingsSection.tsx`**: ~~At exactly 400 lines~~ **RESOLVED in #212** — reduced to ~105 lines after extracting NamingSettingsSection
- **`src/shared/schemas/settings/library.ts`**: Schema refinement chains (hasTitle + validateTokens) are still duplicated inline between folderFormatSchema/fileFormatSchema and libraryFormSchema because Zod v4's type system doesn't allow generic refinement wrapper functions that satisfy ZodObject shape constraints. Could be revisited if Zod v4 adds better type utilities (discovered in #212)
