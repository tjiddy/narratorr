# Technical Debt

- **`src/server/utils/paths.ts` / `src/server/utils/import-helpers.ts`**: `extractYear()` is duplicated in both files — should be shared from one location (discovered in #210)
- **`src/client/pages/settings/LibrarySettingsSection.tsx`**: At exactly 400 lines (the max-lines limit). Any new feature addition will require extracting more logic first (discovered in #210)
