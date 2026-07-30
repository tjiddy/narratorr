import { useLayoutEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Badge } from '@/components/Badge';
import { DownloadIcon, LoadingSpinner, RefreshIcon } from '@/components/icons';
import { api, ApiError, formatBytes, type CompanionEbookCandidate, type CompanionEbookState } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import {
  AMBIGUOUS_QUESTION,
  AMBIGUOUS_SUBMIT,
  BADGE_VARIANTS,
  DETAIL_SEPARATOR,
  DOWNLOAD_LABEL,
  DRM_BODY,
  NONE_BODY_CODE,
  NONE_BODY_PREFIX,
  NONE_BODY_SUFFIX,
  PILLS,
  REFRESH_ERROR_TOAST,
  REFRESH_LABEL,
  SECTION_HEADING,
  ambiguousPill,
  chapterCountText,
  invalidSentence,
} from './companion-ebook-copy.js';
import { useCompanionChapterCount, retryUnlessDisabled } from './useCompanionChapterCount.js';
import { useCompanionEbookSelection, type CompanionEbookSelection } from './useCompanionEbookSelection.js';

/** One `text-sm` card row — the `AudioInfo.tsx` idiom this shell follows exactly. */
function Row({ children, muted }: { children: ReactNode; muted?: boolean }) {
  return <p className={muted ? 'text-sm text-muted-foreground' : 'text-sm'}>{children}</p>;
}

/**
 * The filename as the card's identity line, truncated with the full name in a tooltip.
 * `available` and `drm_protected` render it — "which file" is the panel's identity (and the
 * only disambiguator once a selection has happened). `invalid` keeps its own muted variant
 * below with its own rationale (actionable, not identity); the two are deliberately not
 * unified because they answer different questions at different visual weights.
 */
function FilenameRow({ filename }: { filename: string | null }) {
  if (filename === null) return null;
  return (
    <Row>
      <span className="block truncate" title={filename}>{filename}</span>
    </Row>
  );
}

/**
 * Purely presentational (#2022): `chapterCount` arrives already resolved to a number or `null`,
 * where `null` means "not renderable" for ANY reason — the metadata query is disabled, has no
 * successful response yet, returned `toc: null`, or returned a response describing a different
 * file. The coherence decision lives in the section, not here.
 */
function AvailableBody({ filename, sizeBytes, chapterCount }: {
  filename: string | null;
  sizeBytes: number | null;
  chapterCount: number | null;
}) {
  // `sizeBytes !== null`, never a truthiness test: `0` is a known size and `formatBytes(0)`
  // deliberately returns "0 B", which a `?` guard would erase. When it IS null the term is
  // omitted rather than formatted — `formatBytes` reports "0 B" for a nullish argument, a
  // confident falsehood about a file that exists.
  //
  // §7's `size · chapter count`, built from the parts actually present so a missing size leaves
  // no leading separator and a missing count no trailing one. Both absent omits the row
  // entirely, as it always has. No download link here: the action lives in the section header's
  // icon row (Series-card idiom) — the card body is purely informational.
  const parts: string[] = [];
  if (sizeBytes !== null) parts.push(formatBytes(sizeBytes));
  if (chapterCount !== null) parts.push(chapterCountText(chapterCount));

  return (
    <>
      <FilenameRow filename={filename} />
      {parts.length > 0 && <Row muted>{parts.join(DETAIL_SEPARATOR)}</Row>}
    </>
  );
}

function NoneBody() {
  // The <code> is presentational; the element's accessible text content equals NONE_BODY.
  return (
    <Row muted>
      {NONE_BODY_PREFIX}
      <code className="font-mono">{NONE_BODY_CODE}</code>
      {NONE_BODY_SUFFIX}
    </Row>
  );
}

function InvalidBody({ filename, validationCode }: { filename: string | null; validationCode: string | null }) {
  return (
    <>
      {/* The filename renders here because it is ACTIONABLE (the owner must find the file).
          When it is null there is nothing actionable to show, so the row is omitted rather
          than blanked or filled with invented fallback copy. */}
      {filename !== null && (
        <Row muted>
          <span className="block truncate" title={filename}>{filename}</span>
        </Row>
      )}
      <Row>{invalidSentence(validationCode)}</Row>
    </>
  );
}

function DrmBody({ filename, sizeBytes }: { filename: string | null; sizeBytes: number | null }) {
  return (
    <>
      <FilenameRow filename={filename} />
      {sizeBytes !== null && <Row muted>{formatBytes(sizeBytes)}</Row>}
      <Row>{DRM_BODY}</Row>
    </>
  );
}

function AmbiguousBody({ bookId, candidates, selection }: {
  bookId: number;
  candidates: CompanionEbookCandidate[];
  selection: CompanionEbookSelection;
}) {
  const { pickedFilename, setPickedFilename, picked, mutation } = selection;
  return (
    <>
      <Row muted>{AMBIGUOUS_QUESTION}</Row>
      <div className="text-sm space-y-2">
        <div className="space-y-1">
          {candidates.map((candidate) => (
            // Keyed and checked by FILENAME (`stable-list-keys`): the server-issued index is
            // positional and a refetch can reorder it under the owner's pick.
            <label key={candidate.filename} className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name={`ebook-candidate-${bookId}`}
                value={candidate.filename}
                checked={candidate.filename === pickedFilename}
                onChange={() => setPickedFilename(candidate.filename)}
                className="shrink-0"
              />
              <span className="truncate" title={candidate.filename}>{candidate.filename}</span>
            </label>
          ))}
        </div>
        {/* The route is not idempotent-safe against double submits in any useful sense; the
            button is the guard. `picked` is null when nothing is chosen AND when a refetch
            dropped the chosen file, so both disable it. */}
        <button
          type="button"
          disabled={picked === null || mutation.isPending}
          onClick={() => { if (picked) mutation.mutate(picked.index); }}
          className="px-3 py-1.5 bg-primary text-primary-foreground font-medium rounded-lg hover:opacity-90 disabled:opacity-50 transition-all text-sm focus-ring"
        >
          {AMBIGUOUS_SUBMIT}
        </button>
      </div>
    </>
  );
}

function pillText(state: CompanionEbookState): string {
  // `candidates.length`, NOT `candidateCount` — the pill is sourced from the array the radios
  // render, so a count that disagrees with the list beneath it is not expressible.
  return state.status === 'ambiguous' ? ambiguousPill(state.candidates.length) : PILLS[state.status];
}

function StateBody({ bookId, state, selection, chapterCount }: {
  bookId: number;
  state: CompanionEbookState;
  selection: CompanionEbookSelection;
  chapterCount: number | null;
}) {
  switch (state.status) {
    case 'available':
      return <AvailableBody filename={state.filename} sizeBytes={state.sizeBytes} chapterCount={chapterCount} />;
    case 'none':
      return <NoneBody />;
    case 'ambiguous':
      return <AmbiguousBody bookId={bookId} candidates={state.candidates} selection={selection} />;
    case 'invalid':
      return <InvalidBody filename={state.filename} validationCode={state.validationCode} />;
    case 'drm_protected':
      return <DrmBody filename={state.filename} sizeBytes={state.sizeBytes} />;
  }
}

/**
 * The header's download affordance (Series-card icon idiom, w-4 h-4 muted). TWO shapes:
 *
 * - `available` and `drm_protected` → a real anchor, not a fetch-to-blob, and the href carries
 *   `URL_BASE` — a bare `/api/...` href silently breaks every sub-path deployment. Accessible
 *   name stays `DOWNLOAD_LABEL`, so tests and screen readers see the same control that used to
 *   live in the card body.
 * - everything else → nothing. `none` has no file, `ambiguous` has no chosen file, and
 *   `invalid`'s file is not servable; absence is accurate for all three.
 *
 * **`drm_protected` joined the anchor in #2038**, when the server split its one exposure gate
 * into advertisement and owner-readability. It previously rendered a DISABLED button with a
 * "download unavailable" tooltip, because a live link would have 404ed against an
 * `available`-only gate. `isCompanionEbookOwnerReadable` now admits the stored DRM row, so the
 * link resolves — and the disabled shape is gone rather than kept, since nothing is blocked to
 * explain. The card body still says why the file can't go to Kindle, which is the half of the
 * old sentence that was always true.
 */
function HeaderDownload({ bookId, status }: { bookId: number; status: CompanionEbookState['status'] }) {
  if (status !== 'available' && status !== 'drm_protected') return null;
  return (
    <a
      href={api.getCompanionEbookDownloadUrl(bookId)}
      download
      aria-label={DOWNLOAD_LABEL}
      title={DOWNLOAD_LABEL}
      className="text-muted-foreground hover:text-foreground transition-colors focus-ring rounded"
    >
      <DownloadIcon className="w-4 h-4" />
    </a>
  );
}

/**
 * The **Ebook** section on book details (#1963, plan §7). Purely presentational: every route it
 * calls already exists. It reads `GET /companion-epub/state` always, and `GET
 * /companion-epub/metadata` only while the state it renders is `available` (#2022) — never
 * `/cover`.
 *
 * Five states, mapped from the FIVE wire statuses. The plan's §7 table names the empty state
 * `unavailable`; no such literal exists on the wire, so API `none` renders it and no
 * `unavailable` literal appears anywhere in this code.
 *
 * **Absence is the whole error surface, with one exception.** While the query is pending, and
 * on an initial-load failure of any status or cause (`404` the feature does not apply, `409`
 * disabled, `503` candidate listing undetermined, a plain network rejection), the section is
 * simply absent: no error text, no skeleton, no placeholder, no retry affordance. There is no
 * status special-casing on that path because every cause means the same thing there.
 *
 * Once `data` exists, data WINS over a failed refetch — TanStack keeps the last resolved value
 * and reports the failure separately, so a transient refetch failure never blanks a panel that
 * has already rendered. An ebook that silently vanishes reads like data loss, and Refresh &
 * Scan invalidates this exact query, which makes the failing-refetch path routine.
 *
 * The one exception is `409`, and it does not generalise. It is the only status `/state`
 * emits for `companionEpub.enabled === false`, so it is a DURABLE statement about
 * applicability rather than a failed attempt to observe: keeping a cached `Available` pill and
 * a live download link after the owner turned the feature off would contradict the flag's
 * whole promise. `404` is genuinely ambiguous (a directory outage produces one), and `503` and
 * network failures are transient by construction, so both stay under data-wins.
 *
 * **Accepted narrowing.** §7 promises the card keeps showing the last stored observation while
 * the mount is briefly unreachable. On a COLD first load that is not deliverable from the
 * client: `/state` runs eligibility (which `stat`s the book directory and returns false for
 * every error, including `EIO`/`ESTALE`) BEFORE it reads the stored row, so the route answers
 * `404` and the row is never read. Delivering it would mean reordering the gate on a shipped
 * route. The gap is bounded to a page reload or a cache eviction that coincides with the
 * outage — every remount after the first is served from cache. Do not "fix" this with
 * client-side retry or by caching `/state` outside the query cache.
 */
/**
 * How the panel observes a forced re-check (#2034). The server answers `202` BEFORE the
 * reconcile runs, so invalidating on the 202 alone races it — the refetch can read the OLD
 * row and the panel then sits stale until the next mount. After a refresh is accepted, the
 * state query polls briefly; the reconcile is sub-second for one book, so the second or
 * third tick lands the new verdict. The window is bounded — this must never become a
 * standing poll — and it is not cleared early on "data changed" because a forced re-check
 * can legitimately produce an IDENTICAL row, which is indistinguishable from "not done yet".
 */
const REFRESH_POLL_INTERVAL_MS = 700;
const REFRESH_POLL_WINDOW_MS = 5_000;

/**
 * The minimum time the re-check arrow renders as a spinner after a click. The POST answers
 * 202 in tens of milliseconds, and `isPending` alone left the icon visually inert — the click
 * looked like it did nothing. The spinner therefore runs for at least this long (longer only
 * if the request itself is slower), which is enough to read as "it did something" without
 * pretending the whole 5s poll window is active work — that window cannot know when the
 * reconcile actually finished (an identical row is indistinguishable from "not done yet"),
 * so spinning through it would read as slow on every click.
 */
const REFRESH_MIN_SPIN_MS = 800;

export function CompanionEbookSection({ bookId }: { bookId: number }) {
  const queryClient = useQueryClient();
  const [pollUntil, setPollUntil] = useState<number | null>(null);

  // The min-spin latch. The timer clears UNCONDITIONALLY — no deadline re-check, no clock
  // read. That is safe because overlapping spins are impossible by construction: the button
  // is disabled while `minSpinning || isPending`, so a second click cannot arrive until the
  // first timer has already cleared the latch. (An earlier version re-checked a Date.now()
  // deadline ref "so a second click extends the spin" — dead code under that invariant, and
  // its only live behavior was a stuck latch when the wall clock stepped BACKWARD inside the
  // window: the timer fired early by wall-clock terms, the no-op branch ran, and nothing ever
  // re-armed. Caught by post-delivery assessment. If the `disabled` expression ever changes,
  // re-examine this.) A timer firing after unmount hits a React-18 no-op setState.
  const [minSpinning, setMinSpinning] = useState(false);
  const startMinSpin = () => {
    setMinSpinning(true);
    window.setTimeout(() => setMinSpinning(false), REFRESH_MIN_SPIN_MS);
  };

  const { data, error } = useQuery({
    queryKey: queryKeys.companionEbook(bookId),
    queryFn: () => api.getCompanionEbookState(bookId),
    // The app default is 60s (`main.tsx`); every mount must re-check rather than serve a
    // minute-old answer, which is what makes a remount after a disable actually re-request.
    staleTime: 0,
    // Function form, not a computed value: react-query re-evaluates it after every fetch, so
    // the window shuts off on the first tick past the deadline without needing a re-render —
    // and the clock read happens inside react-query's callback, never during render.
    refetchInterval: () =>
      pollUntil !== null && Date.now() < pollUntil ? REFRESH_POLL_INTERVAL_MS : false,
    // A `409` never retries — otherwise a cached `Available` pill and a live download link stay
    // on screen for seconds after the owner turned the feature off.
    retry: retryUnlessDisabled,
  });

  // The chapter count (#2022) — the `enabled` gate, the filename coherence rule, and the
  // mismatch-recovery revalidation, all in one hook so this component stays a renderer.
  const chapterCount = useCompanionChapterCount(bookId, data);

  // No post-unmount generation guard here, deliberately (contrast useReplaceGrab): the error
  // toast is global UI rather than tree-local, still correct after a navigation; the
  // `setPollUntil` on an unmounted tree is a React-18 no-op; and the invalidation is exactly
  // the kind of unconditional cache work the guard pattern leaves unguarded on purpose.
  const refresh = useMutation({
    mutationFn: () => api.refreshCompanionEbook(bookId),
    onSuccess: () => {
      setPollUntil(Date.now() + REFRESH_POLL_WINDOW_MS);
      void queryClient.invalidateQueries({ queryKey: queryKeys.companionEbook(bookId) });
    },
    onError: () => {
      toast.error(REFRESH_ERROR_TOAST);
    },
  });

  const selection = useCompanionEbookSelection(bookId, data?.candidates ?? []);

  // The SYNCHRONOUS teardown seam (AC24/AC26). A `useLayoutEffect` cleanup runs on unmount AND
  // before a book change commits; a passive `useEffect` cleanup runs after the next book has
  // already committed, leaving a window where a settling selection could toast against it or a
  // pick made on one book could still be checked on another. `BookPage` does not key
  // `BookDetails` on the route id, so both teardown shapes are live.
  const { reset } = selection;
  useLayoutEffect(() => reset, [bookId, reset]);

  if (!data) return null;
  if (error instanceof ApiError && error.status === 409) return null;

  return (
    <div>
      {/* The Series-card header idiom: label left, icon affordances right. `mb-3` moved from
          the h2 to this wrapper when the header gained the icon row. */}
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          {SECTION_HEADING}
        </h2>
        <div className="flex items-center gap-2">
          <HeaderDownload bookId={bookId} status={data.status} />
          {/* Present in EVERY state — `none` is the flagship flow (drop a file, look again),
              and DRM/invalid are where a stale verdict needs re-judging (#2034). */}
          <button
            type="button"
            onClick={() => { startMinSpin(); refresh.mutate(); }}
            disabled={refresh.isPending || minSpinning}
            aria-label={REFRESH_LABEL}
            title={REFRESH_LABEL}
            className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 focus-ring rounded"
          >
            {refresh.isPending || minSpinning
              ? <LoadingSpinner className="w-4 h-4" />
              : <RefreshIcon className="w-4 h-4" />}
          </button>
        </div>
      </div>
      <div className="glass-card rounded-2xl p-4 space-y-2">
        {/* No pill on `available` (Todd, 2026-07-29): once the filename, size, and live
            download icon are visible, "Available" is a fourth voice repeating three others —
            the card's contents ARE the existence proof. A badge appears only when something
            needs SAYING: `None` (empty state reads as intentional), `N found` (demands a
            choice), `Not readable` / `DRM-protected` (explain a problem). Quiet means healthy. */}
        {data.status !== 'available' && (
          <p className="text-sm flex items-center gap-2">
            <Badge variant={BADGE_VARIANTS[data.status]}>{pillText(data)}</Badge>
          </p>
        )}
        <StateBody bookId={bookId} state={data} selection={selection} chapterCount={chapterCount} />
      </div>
    </div>
  );
}
