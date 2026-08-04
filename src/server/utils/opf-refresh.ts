import type { FastifyBaseLogger } from 'fastify';
import type { BookService } from '../services/book.service.js';
import type { SettingsService } from '../services/settings.service.js';
import { writeOpfSidecar, type OpfWriteOutcome } from './opf-writer.js';
import { serializeError } from './serialize-error.js';

export interface RefreshOpfForBookArgs {
  settingsService: SettingsService;
  bookService: BookService;
  bookId: number;
  /** The book's on-disk folder. `null` for a not-yet-imported book → explicit skip (no null join). */
  bookFolder: string | null;
  log: FastifyBaseLogger;
}

/**
 * ## The metadata-mutation matrix (#2098 AC15)
 *
 * Every PER-BOOK OPF trigger routes through this function, which makes it the one place the whole
 * policy is visible. Each row records whether the flow refreshes the sidecar, whether it re-tags
 * the audio files, and what gates the re-tag — plus the behavioural test that pins the cell, so
 * the table is enforced rather than aspirational.
 *
 * | Flow | OPF | Retag | Gate on retag | Pinned by |
 * |---|---|---|---|---|
 * | Edit Metadata (`PUT /api/books/:id`) | yes | **no** | — | `books.test.ts` — `describe('PUT /api/books/:id — OPF sidecar refresh (#1670)')`, incl. `it('never re-tags — the PUT route has no retagFiles opt-in')` |
 * | Cover upload (`POST /api/books/:id/cover`) | yes | no | — | `books.test.ts` — `describe('OPF sidecar refresh (#1670)')` + `describe('connector refresh aggregation (#1707)')` under `describe('POST /api/books/:id/cover')` |
 * | Fix Match (`POST /api/books/:id/fix-match`) | yes | yes | per-request `retagFiles` opt-in | `books.test.ts` — `describe('post-commit rename/retag follow-up (F3)')` |
 * | Series bind (`POST /api/books/:id/series/bind`) | yes | yes | global `tagging.enabled` (no per-request opt-in exists) | `books.test.ts` — `describe('POST /api/books/:id/series/bind — post-bind sidecar + tag refresh (#2098)')` |
 * | Bulk re-tag job | via its own retag path | yes | operator started the job | `bulk-operation.service.test.ts` — `it('skips book with NO_PATH silently (not counted as failure)')`, `it("enqueues a 'metadata' refresh for a book that tagged ≥1 file, and none for an all-skipped book")` |
 * | Bulk sidecar reconcile job | yes (ungated — the button IS the opt-in) | no | — | `bulk-sidecar-reconcile.test.ts` — `it('writes OPF with enabled:true (reconcile ignores the global writeOpf setting)')`, `it("OPF 'skipped' (foreign/missing) is NOT a failure")` |
 *
 * **The two BULK jobs bypass this module** — they call `writeOpfSidecar` directly
 * (`bulk-sidecar-reconcile.ts`), because the reconcile button is itself the opt-in and must ignore
 * the `writeOpf` gate this helper applies. They are in the table because the table is the policy;
 * they are not callers of this function, so it is documentation here, not a universal code path.
 *
 * **Not in the table, and why.** Three other flows touch one of the two artifacts but are not
 * metadata-mutation flows: the manual import adapter writes the sidecar once at import time
 * (`import-adapters/manual.ts`, via `writeOpfForImport`); `POST /api/books/:id/retag` is the
 * operator's explicit tag-only action; and the post-merge tag step (`merge-post-tag.ts`) re-tags a
 * merge output whose DB metadata did not change. None of them rewrites a book's metadata, so none
 * of them owes the other artifact a refresh.
 *
 * **Why Edit Metadata stays OPF-only.** An audio re-tag is a destructive, ffmpeg-cost, in-place
 * file rewrite. The PUT route has no `retagFiles` opt-in in its schema or its UI, and the
 * operator's explicit path for that is `POST /api/books/:id/retag`; a silent re-tag on every field
 * edit would be a surprise, not a convenience. Series bind is the asymmetric case: it has no
 * per-request opt-in either, so the global `tagging.enabled` IS its opt-in — an operator who wants
 * embedded tags to track the DB has already said so, and a bind is exactly the mutation that
 * invalidates the `series`/`seriesPart` fields on every book it touches.
 *
 * Refresh a book's `metadata.opf` sidecar after a metadata-changing edit (PUT, Fix Match, cover
 * upload, series bind). Gated ONLY on the global `tagging.writeOpf` setting — deliberately independent of the
 * per-request `retagFiles`/audio-retag opt-in, so an edited book's OPF never drifts from the DB.
 *
 * Best-effort and nonfatal: a not-imported book (`bookFolder === null`) is skipped BEFORE the writer
 * is called (passing a null folder would `join(undefined, …)` a stray file into the process CWD), and
 * any failure is logged and swallowed so the edit/upload response still succeeds. Lives in its own
 * module (not alongside `writeOpfSidecar`) so route/service tests can spy on the writer export.
 *
 * Returns the underlying {@link OpfWriteOutcome} so callers can fire a connector refresh only when an
 * OPF actually got `'written'` (NOT on `'skipped'` — foreign-OPF preserve / `writeOpf` off / book
 * missing — nor on `'failed'`). The not-imported short-circuit reports `'skipped'`. Calls
 * `writeOpfSidecar` directly (not the void `writeOpfForImport` wrapper) so the outcome is observable.
 */
export async function refreshOpfForBook(args: RefreshOpfForBookArgs): Promise<OpfWriteOutcome> {
  const { settingsService, bookService, bookId, bookFolder, log } = args;
  if (!bookFolder) return 'skipped'; // not imported — never call the writer with a null folder

  try {
    const tagging = await settingsService.get('tagging');
    return await writeOpfSidecar({ enabled: tagging.writeOpf, bookService, bookId, bookFolder, log });
  } catch (error: unknown) {
    log.warn({ error: serializeError(error), bookId }, 'Failed to refresh metadata.opf after edit — continuing');
    return 'failed';
  }
}
