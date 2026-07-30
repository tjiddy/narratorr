import { useLayoutEffect, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/Badge';
import { DownloadIcon } from '@/components/icons';
import { api, ApiError, formatBytes, type CompanionEbookCandidate, type CompanionEbookState } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import {
  AMBIGUOUS_QUESTION,
  AMBIGUOUS_SUBMIT,
  BADGE_VARIANTS,
  DOWNLOAD_LABEL,
  DRM_BODY,
  DRM_DOWNLOAD_DISABLED_TITLE,
  NONE_BODY_CODE,
  NONE_BODY_PREFIX,
  NONE_BODY_SUFFIX,
  PILLS,
  SECTION_HEADING,
  ambiguousPill,
  invalidSentence,
} from './companion-ebook-copy.js';
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

function AvailableBody({ filename, sizeBytes }: { filename: string | null; sizeBytes: number | null }) {
  return (
    <>
      <FilenameRow filename={filename} />
      {/* `sizeBytes !== null`, never a truthiness test: `0` is a known size and
          `formatBytes(0)` deliberately returns "0 B", which a `?` guard would erase.
          When it IS null the row is omitted entirely rather than formatted — `formatBytes`
          reports "0 B" for a nullish argument, a confident falsehood about a file that exists.
          No chapter count here: §7 specifies `size · chapter count`, but the count needs a
          server change first (#2022), so this row is a single value, not a joined parts array.
          No download link here either: the action moved to the section header's icon row
          (Series-card idiom) — the card body is purely informational. */}
      {sizeBytes !== null && <Row muted>{formatBytes(sizeBytes)}</Row>}
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

function StateBody({ bookId, state, selection }: {
  bookId: number;
  state: CompanionEbookState;
  selection: CompanionEbookSelection;
}) {
  switch (state.status) {
    case 'available':
      return <AvailableBody filename={state.filename} sizeBytes={state.sizeBytes} />;
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
 * The header's download affordance (Series-card icon idiom, w-4 h-4 muted). Three shapes:
 *
 * - `available` → a real anchor, not a fetch-to-blob, and the href carries `URL_BASE` — a
 *   bare `/api/...` href silently breaks every sub-path deployment. Accessible name stays
 *   `DOWNLOAD_LABEL`, so tests and screen readers see the same control that used to live in
 *   the card body.
 * - `drm_protected` → DISABLED button, not absent: "there is a download here and it is
 *   blocked" communicates more than silence, and the tooltip carries the why. It must stay a
 *   non-anchor while the server's exposure gate is `available`-only — an enabled link here
 *   would 404.
 * - everything else → nothing. `none` has no file, `ambiguous` has no chosen file, and
 *   `invalid`'s file is not servable; absence is accurate there, unlike DRM's "blocked".
 *
 * #2034's refresh arrow lands beside this when its endpoint ships.
 */
function HeaderDownload({ bookId, status }: { bookId: number; status: CompanionEbookState['status'] }) {
  if (status === 'available') {
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
  if (status === 'drm_protected') {
    return (
      <button
        type="button"
        disabled
        aria-label={DOWNLOAD_LABEL}
        title={DRM_DOWNLOAD_DISABLED_TITLE}
        className="text-muted-foreground opacity-40 cursor-not-allowed"
      >
        <DownloadIcon className="w-4 h-4" />
      </button>
    );
  }
  return null;
}

/**
 * The **Ebook** section on book details (#1963, plan §7). Purely presentational: every route
 * it calls already exists, and it issues exactly one read — `GET /companion-epub/state`.
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
export function CompanionEbookSection({ bookId }: { bookId: number }) {
  const { data, error } = useQuery({
    queryKey: queryKeys.companionEbook(bookId),
    queryFn: () => api.getCompanionEbookState(bookId),
    // The app default is 60s (`main.tsx`); every mount must re-check rather than serve a
    // minute-old answer, which is what makes a remount after a disable actually re-request.
    staleTime: 0,
    // Production leaves `retry` unset, so without this predicate a `409` would sit in
    // `failureReason` through the default backoff ladder and only reach `error` after the last
    // attempt — keeping a cached `Available` pill and a live download link on screen for
    // seconds. Retrying a `409` is pointless on its own terms: it reports a SETTING, which
    // cannot change between backoff attempts. Everything else keeps the client's three retries.
    retry: (failureCount, queryError) =>
      !(queryError instanceof ApiError && queryError.status === 409) && failureCount < 3,
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
        </div>
      </div>
      <div className="glass-card rounded-2xl p-4 space-y-2">
        <p className="text-sm flex items-center gap-2">
          <Badge variant={BADGE_VARIANTS[data.status]}>{pillText(data)}</Badge>
        </p>
        <StateBody bookId={bookId} state={data} selection={selection} />
      </div>
    </div>
  );
}
