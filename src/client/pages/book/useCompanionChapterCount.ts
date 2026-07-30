import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type CompanionEbookState } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';

/**
 * The 409-aware retry predicate BOTH of the Ebook panel's queries use (#2022 AC18).
 *
 * Production leaves `retry` unset, so without it a `409` would sit in `failureReason` through
 * the default backoff ladder and only reach `error` after the last attempt. Retrying a `409` is
 * pointless on its own terms: it reports a SETTING, which cannot change between backoff
 * attempts. Everything else keeps the client's three retries.
 *
 * It lives here rather than in `CompanionEbookSection.tsx` only because the panel imports this
 * module and not the other way round; the rule belongs to both queries equally.
 */
export function retryUnlessDisabled(failureCount: number, queryError: unknown): boolean {
  return !(queryError instanceof ApiError && queryError.status === 409) && failureCount < 3;
}

/**
 * The Ebook panel's chapter count (#2022), resolved to a number or `null`.
 *
 * `null` means "not renderable" for ANY reason — the read is gated off, no successful response
 * exists yet, the archive had no readable TOC, or the response describes a different file. The
 * caller renders a number or nothing; it never learns which.
 *
 * **Why this is not simply `toc.length` from a second query.** `/state` and `/metadata` read
 * `companion_ebooks` INDEPENDENTLY and a reconcile can commit between them — Refresh & Scan
 * starts one fire-and-forget and then invalidates the book prefix, background-refetching both.
 * So without a binding, one file's size renders beside another file's chapter count with both
 * requests succeeding. The server therefore declares the basename it read, and this hook
 * discards a response that does not name the row being rendered.
 *
 * Three separate guards doing three different jobs, none substituting for another: the `enabled`
 * gate stops pointless `404`s (and the reconciles they enqueue), the coherence check stops a
 * WRONG number, and the recovery effect stops a PERMANENTLY MISSING one.
 */
export function useCompanionChapterCount(bookId: number, state: CompanionEbookState | undefined): number | null {
  const queryClient = useQueryClient();

  /**
   * Guard 1, the `enabled` gate: the read fires only while the value being RENDERED is
   * `available` with a filename. `none`, `ambiguous`, and `invalid` fail the server's
   * stored-status gate and would `404`; `drm_protected` passes that gate but §7 gives it its own
   * body, and the panel stays there until a re-check moves it.
   *
   * This is a statement about what the client STARTS, never about what the server then reads —
   * the route performs its own row read and a reconcile can commit in between. A request started
   * while `available` can legitimately arrive after a commit to `drm_protected`; that is the
   * route's own accepted characteristic and it surfaces here as an ordinary metadata failure.
   */
  const stateFilename = state?.status === 'available' ? state.filename : null;

  const metadata = useQuery({
    // The filename is part of the key, so a `/state` move switches to that filename's OWN entry
    // rather than reinterpreting the previous one. The key is an INDEX, never evidence: it
    // records what the client EXPECTED when it issued the request and promises nothing about
    // when a request happens or which file the stored response actually describes.
    //
    // No `staleTime` override: freshness is not what makes the count correct (the response's
    // filename is), and inheriting `main.tsx`'s 60s default avoids re-requesting on every
    // remount in the common case. That is a tendency, not a promise — the book-prefix cascade
    // invalidates this entry on every Refresh & Scan.
    queryKey: queryKeys.companionEbookMetadata(bookId, stateFilename ?? ''),
    queryFn: () => api.getCompanionEbookMetadata(bookId),
    enabled: stateFilename !== null,
    retry: retryUnlessDisabled,
  });

  // `enabled: false` stops FETCHING; it does not empty the entry, and TanStack hands a disabled
  // observer whatever that key already holds. Masking here is what keeps a response left behind
  // by an earlier race from feeding either the count or the recovery effect while the panel
  // renders a non-`available` status.
  const observed = stateFilename !== null ? metadata.data : undefined;
  const metadataFilename = observed?.filename ?? null;

  /**
   * Guard 2, the coherence rule: the count renders only when the server's declaration of what it
   * read matches the `/state` row on screen AND a TOC was actually readable. Otherwise it is
   * simply absent — no placeholder, no "unknown", no error text, no toast.
   *
   * `toc === null` is "we could not read one", never zero chapters, and `src/core/epub/extract.ts`
   * never emits `[]`, so a rendered count is always `>= 1`.
   *
   * A retained response is judged on exactly the same terms as a fresh one — the filename is the
   * binding, not the freshness — so a refetch failure that leaves last-good data in place keeps
   * the count rendering, matching the panel's own data-wins rule for `/state`. Derived every
   * render, never copied into `useState` (`derived-state-over-copied`): a local copy would go
   * stale against the cache and reintroduce the very incoherence this closes.
   */
  const coherent = metadataFilename !== null && metadataFilename === stateFilename;
  const toc = coherent ? (observed?.toc ?? null) : null;

  /**
   * Guard 3, recovery. Detection alone leaves the count permanently missing for the flow that
   * motivates it: Refresh & Scan performs ONE book-prefix invalidation against a fire-and-forget
   * server reconcile, so `/state` can refetch before the commit lands and nothing ever re-reads
   * it. #2034's poll window does not cover this — `pollUntil` is armed only by the panel's own
   * re-check mutation — and no signal is threaded between components.
   *
   * `exact: true` is required. `companionEbook(bookId)` is also this metadata key's PREFIX, so a
   * prefix invalidation would refetch `/metadata` under the still-stale filename, re-read the
   * same newer row, return the same mismatched answer, and burn a second `inspectEpub` for
   * nothing. Only `/state` holds the stale value.
   *
   * The guarantee is "recovery happens, and cannot spin" — explicitly NOT "fires exactly once
   * per pair". What bounds it is that the dependencies are primitive STRINGS: a revalidation
   * returning the same row yields a new `data` object but the same filename, so `Object.is` holds
   * and React does not re-run the effect. Strict Mode's development-only double setup, a
   * non-consecutive return to the same pair, and a remount with a cached mismatch all fire again,
   * and every one of those is correct. Do NOT add a ref, a `Set` of handled pairs, a counter, or
   * a timer to suppress them: all such a registry buys is one cheap `GET /state` on a page the
   * owner is already looking at, against added state, a per-book reset rule, and Strict-Mode
   * reasoning.
   *
   * `queryClient` is in the dependency list because the effect calls it (`exhaustive-deps`, and
   * `pages/library/useImportPolling.ts` is the local precedent). It is referentially stable, so
   * it never participates in re-firing — the two filenames are the logical identity.
   */
  useEffect(() => {
    if (stateFilename === null || metadataFilename === null) return;
    if (stateFilename === metadataFilename) return;
    void queryClient.invalidateQueries({ queryKey: queryKeys.companionEbook(bookId), exact: true });
  }, [queryClient, bookId, stateFilename, metadataFilename]);

  return toc === null ? null : toc.length;
}
