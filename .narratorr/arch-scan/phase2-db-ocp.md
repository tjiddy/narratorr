# Phase 2: DB & Structural Architecture Scan

Scanned: all `src/server/services/*.ts`, `src/server/jobs/enrichment.ts`, `src/server/utils/import-steps.ts`, `src/core/*/registry.ts`, `src/shared/*-registry.ts`.

---

## DB-1 — Late DB update after filesystem

### DB-1.1 — import.service.ts: DB update trails behind filesystem copy (suggestion)

**File:** `src/server/services/import.service.ts`, lines 122-134

The import pipeline performs: `copyToLibrary` (L122) -> `runAudioProcessing` (L123) -> `renameFilesWithTemplate` (L126-127) -> `verifyCopy` (L128) -> `cleanupOldBookPath` (L129) -> **then** `db.update(books)` (L131).

The first irreversible step is `copyToLibrary` (L122). If `runAudioProcessing` or `verifyCopy` throws, the files are already on disk but the DB still shows the old state. The `handleImportFailure` catch block does clean up (rm target, revert statuses), so this is mitigated by the error handler, but the correct pattern is to update the DB path immediately after `copyToLibrary` succeeds, before running processing/verification.

**Severity:** suggestion (mitigated by error handler cleanup)

### DB-1.2 — library-scan.service.ts: copyToLibrary before DB path update (suggestion)

**File:** `src/server/services/library-scan.service.ts`, lines 426-443 (`copyToLibrary` method)

In `processOneImport` (L531-587) and `enrichImportedBook` (L333-385): the pipeline does `copyToLibrary` (file copy/move) first, then `db.update(books).set({ path: finalPath })` afterward (L347/L552). If the DB update fails, files are orphaned at `targetPath` with no DB record pointing to them.

**Severity:** suggestion (the DB update is only 2 lines after the copy, and failure here would be a DB connection issue that would affect everything)

### DB-1.3 — bulk-operation.service.ts convertBook: rename before DB update (suggestion)

**File:** `src/server/services/bulk-operation.service.ts`, lines 333-361 (`convertBook`)

The method renames output files back to `bookPath` (L336, `fsRename`), deletes originals (L340-344), then calls `enrichBookFromAudio` which does the DB update. If enrichment fails, the DB has stale audio metadata. However, the merge service (`merge.service.ts` L192-197) does this correctly -- `rename` then immediate `db.update` before deleting originals.

**Severity:** suggestion (enrichment failure is non-fatal and logged)

### Clean patterns (no issues)

- **rename.service.ts** (L85-86): Updates `book.path` in DB immediately after `moveBookFolder` -- explicitly comments "immediately after folder move so it stays in sync even if file rename below fails." Textbook correct.
- **merge.service.ts** (L192-197): `rename` -> immediate `db.update(books).set({ size })` -> then delete originals. Correctly follows the pattern with a comment explaining why.
- **recycling-bin.service.ts** (L99-146): `moveFiles` -> then `db.insert(books)` in restore path. Correct order.
- **import-steps.ts handleImportFailure**: Properly cleans up both filesystem and DB on failure.

---

## DB-2 — Multi-step mutations without transaction

### DB-2.1 — book.service.ts create(): insert + syncAuthors + syncNarrators without transaction (blocking)

**File:** `src/server/services/book.service.ts`, lines 180-216

`create()` does:
1. `db.insert(books)` (L180-196)
2. `syncAuthors(bookId, ...)` (L201) -- which does `db.delete(bookAuthors)` + N x `db.insert(bookAuthors)`
3. `syncNarrators(bookId, ...)` (L202-203) -- which does `db.delete(bookNarrators)` + N x `db.insert(bookNarrators)`

There's a compensating delete in the catch block (L206-208) that removes the orphaned book row, which is good. But if the compensating delete itself fails (DB connection drop), the book row is orphaned without authors. A `db.transaction()` wrapper would make this atomic.

**Severity:** blocking -- the compensating delete is a manual transaction emulation that doesn't cover all failure modes

### DB-2.2 — book.service.ts update(): update + syncNarrators + syncAuthors without transaction (blocking)

**File:** `src/server/services/book.service.ts`, lines 218-239

`update()` does:
1. `db.update(books)` (L220-226)
2. `syncNarrators(id, narratorNames)` (L229-231)
3. `syncAuthors(id, authorList)` (L233-235)

If step 2 succeeds but step 3 fails, the book has updated narrators but stale authors. No compensating action. Should be wrapped in `db.transaction()`.

**Severity:** blocking

### DB-2.3 — book.service.ts syncAuthors/syncNarrators: delete + N inserts without transaction (suggestion)

**File:** `src/server/services/book.service.ts`, lines 102-147

Both `syncAuthors` and `syncNarrators` do `db.delete(bookAuthors/bookNarrators)` followed by N x `db.insert()`. If the process crashes mid-loop, the book has a partial set of authors/narrators. These are called from `create()` and `update()` which should themselves be transactional, so wrapping the callers would fix this transitively.

**Severity:** suggestion (covered if DB-2.1/DB-2.2 are fixed)

### DB-2.4 — enrichment.ts runEnrichment: narrator insert loop + book update without transaction (suggestion)

**File:** `src/server/jobs/enrichment.ts`, lines 107-148

For each candidate book, the enrichment job:
1. Inserts/finds narrators in a loop (L114-129) with `db.insert(narrators)` + `db.insert(bookNarrators)`
2. Then `db.update(books).set(updates)` (L134-136)

If the book update fails, narrator junction rows exist but enrichmentStatus is still 'pending', causing a re-run that would try to re-insert (mitigated by `onConflictDoNothing`). Low risk but technically a multi-step mutation.

**Severity:** suggestion (idempotent via onConflictDoNothing)

### DB-2.5 — recycling-bin.service.ts restore(): insert book + sync authors + sync narrators + delete entry (blocking)

**File:** `src/server/services/recycling-bin.service.ts`, lines 114-148

`restore()` does:
1. `db.insert(books)` (L114-129)
2. `bookService.syncAuthors(newBook.id, ...)` (L133-136)
3. `bookService.syncNarrators(newBook.id, ...)` (L139-140)
4. `db.delete(recyclingBin)` (L143)

Four sequential mutations across three tables with no transaction. If step 4 fails, the recycling bin entry still exists alongside the restored book, and a retry would create a duplicate book.

**Severity:** blocking

### DB-2.6 — import-list.service.ts processItem(): insert book + insert author + insert event (suggestion)

**File:** `src/server/services/import-list.service.ts`, lines 196-236

`processItem()` does:
1. `db.insert(books)` (L199-211)
2. `db.insert(bookAuthors)` (L222-225)
3. `db.insert(bookEvents)` (L228-233)

If step 2 or 3 fails, we have a book without an author junction row or without the grab event. The `onConflictDoNothing` on the book insert provides some idempotency, but partial state is possible.

**Severity:** suggestion (low-stakes data -- import list sync will re-run)

### DB-2.7 — download.service.ts grab(): cancel loop + book status revert + insert download (suggestion)

**File:** `src/server/services/download.service.ts`, lines 246-309

When `replaceExisting` is true, `grab()`:
1. Cancels each replaceable download in a loop (L249-255) -- each cancel does a DB update
2. Reverts book status to 'wanted' (L257)
3. Inserts new download record (L288-305)

If step 3 fails, old downloads are cancelled and book is 'wanted' but no new download exists. The user would need to manually re-grab. Low risk since the system is in a recoverable state.

**Severity:** suggestion

---

## OCP-1 — Growing switch/map

### OCP-1.1 — Adapter registries use static Record maps (clean)

All adapter registries use `Record<string, AdapterFactory>` maps:
- `src/core/download-clients/registry.ts` -- `ADAPTER_FACTORIES`
- `src/core/indexers/registry.ts` -- `ADAPTER_FACTORIES`
- `src/core/notifiers/registry.ts` -- `ADAPTER_FACTORIES`
- `src/core/metadata/registry.ts` -- `METADATA_SEARCH_PROVIDER_FACTORIES`
- `src/core/import-lists/registry.ts` -- `IMPORT_LIST_ADAPTER_FACTORIES`

Adding a new adapter requires adding one entry to the registry map + the corresponding shared registry. No switch/case or if/else chains. The services look up adapters via `factory = FACTORIES[type]` with a `throw` fallback for unknown types. This is the correct pattern.

### OCP-1.2 — IndexerService.RSS_CAPABLE_TYPES static filter list (suggestion)

**File:** `src/server/services/indexer.service.ts`, line 237

```typescript
private static readonly RSS_CAPABLE_TYPES = ['newznab', 'torznab'];
```

This is a capability filter that would need manual updates when adding RSS-capable indexer types. Better approach: add an `rssCapable: boolean` field to the indexer registry metadata, then filter on that.

**Severity:** suggestion (low frequency of change, but violates OCP principle)

---

## OCP-2 — Wiring cost

### Adding a new adapter type requires editing 2-3 files (clean)

For each adapter category, the wiring cost is:
1. **New adapter file** in `src/core/<category>/` (new file)
2. **Registry entry** in `src/core/<category>/registry.ts` (1 line add)
3. **Shared registry** in `src/shared/<category>-registry.ts` (1 entry add for UI metadata)
4. Optionally: **schema update** in `src/shared/schemas.ts` if the type enum needs extending

This is 2-3 existing files to edit, which is under the 4-file threshold. The pattern is well-structured. No OCP-2 violations found.

---

## Summary

| ID | Check | Location | Severity |
|----|-------|----------|----------|
| DB-1.1 | Late DB update | `import.service.ts:122-134` | suggestion |
| DB-1.2 | Late DB update | `library-scan.service.ts:426-552` | suggestion |
| DB-1.3 | Late DB update | `bulk-operation.service.ts:333-361` | suggestion |
| DB-2.1 | No transaction | `book.service.ts:180-216` (create) | **blocking** |
| DB-2.2 | No transaction | `book.service.ts:218-239` (update) | **blocking** |
| DB-2.3 | No transaction | `book.service.ts:102-147` (sync*) | suggestion |
| DB-2.4 | No transaction | `enrichment.ts:107-148` | suggestion |
| DB-2.5 | No transaction | `recycling-bin.service.ts:114-148` | **blocking** |
| DB-2.6 | No transaction | `import-list.service.ts:196-236` | suggestion |
| DB-2.7 | No transaction | `download.service.ts:246-309` | suggestion |
| OCP-1.2 | Growing filter | `indexer.service.ts:237` | suggestion |

**Blocking: 3** | **Suggestions: 8**
