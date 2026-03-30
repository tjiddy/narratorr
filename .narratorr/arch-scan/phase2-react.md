# Phase 2: React Architecture Check Scan

Scanned all `.tsx` files in `src/client/` against REACT-1, REACT-3, REACT-4, REACT-5.

---

## REACT-1 -- God Hooks

**No violations found.**

All custom hooks in `src/client/hooks/` are well-scoped:

| Hook | Return values | Mutations | Notes |
|------|--------------|-----------|-------|
| `useCrudSettings` | 4 grouped objects (`state`, `actions`, `mutations`, `tests`) | 3 (create, update, delete) | Properly grouped -- not flat |
| `useEventHistory` | 7 flat values | 3 (markFailed, delete, bulkDelete) | Borderline on mutations but each is a distinct concern of the same entity |
| `useBookEventHistory` | 5 flat values | 2 | Clean |
| `useBulkOperation` | 4 values | 0 (1 async action) | Clean |
| `useMatchJob` | 6 values | 0 (2 actions) | Clean |
| `useAuth` | 7 values in a named interface | 0 | Clean |
| `useConnectionTest` | 7 values | 0 (2 async handlers) | Clean |
| `usePagination` | 8 values in a named interface | 0 | All pagination-specific, cohesive |
| `useAddBooksToLibrary` | 4 values | 1 | Clean |
| `useLibrarySearch` | 5 values | 0 | Clean |
| `useAudnexusSearch` | 5 values | 1 | Clean |

`useEventHistory` is the closest to the threshold at 7 flat returns and 3 mutations, but the mutations are all event-history-specific (mark failed, delete one, bulk delete). No split needed.

---

## REACT-3 -- Local Form Primitives

### Finding 1: `SelectWithChevron` scoped to `NamingSettingsSection.tsx` (suggestion)

**File:** `src/client/pages/settings/NamingSettingsSection.tsx:63-79`
**Severity:** suggestion

`SelectWithChevron` is a local component that wraps `<select>` with `appearance-none`, a chevron icon overlay, and consistent styling. It is only used within this file.

Meanwhile, the following files use the exact same `<div className="relative"> + <select> + <ChevronDownIcon>` pattern by hand:

- `src/client/pages/library/FilterRow.tsx` (lines 23-36, 40-53, 56-70) -- 3 instances, slightly different styling (smaller `glass-card` variant)
- `src/client/components/manual-import/ImportSummaryBar.tsx` (line 88-90)

The FilterRow instances use a compact variant (`text-xs`, `glass-card`, smaller padding) vs. NamingSettingsSection's full-width settings variant, so a shared component would need a `variant` or `size` prop. Not blocking, but worth extracting if another consumer appears.

### Finding 2: Raw `<select>` elements across settings sections (suggestion)

**Severity:** suggestion

Multiple settings forms use raw `<select>` with identical styling:
```
className="w-full px-4 py-3 bg-background border border-border rounded-xl focus-ring focus:border-transparent transition-all"
```

Files with this exact class string:
- `src/client/pages/settings/MetadataSettingsForm.tsx:76`
- `src/client/pages/settings/QualitySettingsSection.tsx:96`
- `src/client/pages/settings/GeneralSettingsForm.tsx:118`
- `src/client/pages/settings/ProcessingSettingsSection.tsx:257, 314, 359`
- `src/client/components/settings/NotifierCardForm.tsx:49`

These do NOT use `SelectWithChevron` or any shared component. The styling is consistent (the same class string copy-pasted), but there's no custom chevron overlay -- they use the browser-default dropdown arrow.

This is a textbook REACT-3 case: 7+ instances of the same styled select that could be a `<SettingsSelect>` shared component. Not blocking because they all work and look the same, but it's DRY debt.

### Finding 3: Repeated settings input class strings (suggestion)

**Severity:** suggestion

Several settings forms define identical `inputClass` constants locally or inline the same input styling. For example, `ImportListsSettings.tsx` defines a local `inputClass` and `ImportListProviderSettings.tsx` uses the same select styling inline. The shared `FormField` component exists (`src/client/components/settings/FormField.tsx`) and is used in some places (e.g., `ProcessingSettingsSection.tsx:327`) but not consistently.

---

## REACT-4 -- useEffect as Event Handler

### Finding 1: Settings form `useEffect` for `reset()` -- acceptable pattern (no violation)

Multiple settings sections use this pattern:
```tsx
useEffect(() => {
  if (settings?.quality && !isDirty) {
    reset(settings.quality);
  }
}, [settings, reset, isDirty]);
```

Files: `MetadataSettingsForm.tsx:45`, `QualitySettingsSection.tsx:45`, `GeneralSettingsForm.tsx:38`, `ImportSettingsSection.tsx:30`, `LibrarySettingsSection.tsx:37`, `NamingSettingsSection.tsx:161`, `NetworkSettingsSection.tsx:52`, `ProcessingSettingsSection.tsx:159`, `SearchSettingsSection.tsx:60`, `BackupScheduleForm.tsx:27`, `DiscoverySettingsSection.tsx:36`

**Not a violation.** This is synchronization with an external system (server data arriving asynchronously). The effect syncs form state with query data. The `!isDirty` guard prevents overwriting user edits. This is the standard react-hook-form pattern for server-populated forms.

### Finding 2: Focus management effects -- acceptable pattern (no violation)

```tsx
useEffect(() => {
  const buttons = menuRef.current?.querySelectorAll<HTMLButtonElement>('button');
  buttons?.[focusIndex]?.focus();
}, [focusIndex]);
```

Files: `BookContextMenu.tsx:16`, `OverflowMenu.tsx:33`, `StatusDropdown.tsx:24`, `SortDropdown.tsx:61`

**Not a violation.** These are DOM synchronization effects -- imperative focus management that must run after render. There's no event handler that could replace this; `focusIndex` changes via keyboard events and the DOM update must happen post-render.

### Finding 3: Pagination clamp effects -- borderline (suggestion)

```tsx
useEffect(() => { queuePagination.clampToTotal(queueTotal); }, [queueTotal, queuePagination]);
```

Files: `ActivityPage.tsx:30-31`, `EventHistorySection.tsx:48`, `BlacklistSettings.tsx:54`, `LibraryPage.tsx:47`

**Severity:** suggestion

These effects watch `total` (derived from query data) and clamp the current page. This is technically synchronization with derived state -- when the total count changes (e.g., after a deletion), the current page might be out of bounds. The effect fires because the total comes from a query, not from a user action.

Borderline: this could be modeled as derived state inside `usePagination` if it accepted `total` as a parameter, eliminating the need for callers to wire up the effect. But the current approach works and is consistent across all 5 call sites.

### Finding 4: Click-outside effect for menu close -- acceptable (no violation)

```tsx
useEffect(() => {
  if (openMenuId !== null) {
    document.addEventListener('click', closeMenu);
    return () => document.removeEventListener('click', closeMenu);
  }
}, [openMenuId, closeMenu]);
```

File: `LibraryPage.tsx:106`, `BulkActionToolbar.tsx:29`

**Not a violation.** This is synchronization with an external system (the document's click events). The effect sets up and tears down a global event listener based on menu state.

---

## REACT-5 -- Missing Error Boundaries

### Finding 1: Single root-level boundary, no page-level boundaries (suggestion)

**Severity:** suggestion

**Current state:** One `ErrorBoundary` wraps the entire app in `src/client/main.tsx:21-27`. No page-level error boundaries exist anywhere.

**Impact:** A crash in any page component (BookPage, LibraryPage, SettingsLayout, etc.) white-screens the entire app. The root boundary catches it and shows a "Something went wrong / Reload Page" screen, which is better than nothing, but:

- A crash on the BookPage kills navigation -- the user can't click to Library or Settings
- A crash in a settings subsection kills all settings pages
- A crash in the activity feed prevents accessing the library

**Pages that would benefit from individual boundaries:**

| Page | Risk | Why |
|------|------|-----|
| `BookPage` | Medium | Renders server-fetched data with complex metadata display; crash kills navigation |
| `AuthorPage` | Medium | Same -- external data rendering |
| `ManualImportPage` | Medium | File system browsing + complex state machine |
| `LibraryImportPage` | Medium | Scan results + matching job state |
| `DiscoverPage` | Low | Simpler rendering but still external data |
| `SettingsLayout` | Low | Forms are simple but there are many subsections |

This is a "suggestion" because the root boundary prevents a full white-screen, and no crashes have been reported in production. But it violates the REACT-5 principle that "a crash in one section shouldn't kill the whole app." Adding `<ErrorBoundary>` wrappers in `App.tsx` around each `<Route>` element would be minimal effort.

---

## Summary

| Check | Violations | Blocking | Suggestions |
|-------|-----------|----------|-------------|
| REACT-1 (God hooks) | 0 | 0 | 0 |
| REACT-3 (Local form primitives) | 3 findings | 0 | 3 |
| REACT-4 (useEffect as event handler) | 0 true violations | 0 | 1 (pagination clamp) |
| REACT-5 (Missing error boundaries) | 1 finding | 0 | 1 |

**No blocking violations.** The codebase is in good shape on hooks architecture and effect discipline. The main DRY debt is around raw `<select>` elements in settings forms (7+ instances of the same styling that could be a shared component). Error boundaries are minimal but functional.
