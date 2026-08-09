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

function Row({ children, muted }: { children: ReactNode; muted?: boolean }) {
  return <p className={muted ? 'text-sm text-muted-foreground' : 'text-sm'}>{children}</p>;
}

/** Available and DRM filenames identify the file; invalid renders its actionable filename separately. */
function FilenameRow({ filename }: { filename: string | null }) {
  if (filename === null) return null;
  return (
    <Row>
      <span className="block truncate" title={filename}>{filename}</span>
    </Row>
  );
}

/** `chapterCount: null` means omit it; metadata coherence is resolved upstream (#2022). */
function AvailableBody({ filename, sizeBytes, chapterCount }: {
  filename: string | null;
  sizeBytes: number | null;
  chapterCount: number | null;
}) {
  // Null means unknown; zero is a known size. Joining present parts avoids orphan separators.
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
      {/* A missing filename omits the actionable row instead of inventing fallback copy. */}
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
            // Indexes are positional; filename identity survives a reordered refetch.
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
        {/* `picked` also becomes null when a refetch drops the chosen file. */}
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
  // Match the count to the array actually rendered, not the separately reported total.
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

/** Owner-readable available and DRM states get an anchor; all other states get no control (#2038). */
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
 * Cold pending and errors render nothing; cached data survives transient refetch failures, but
 * a 409 hides it after disable. A cold 404 may be a directory outage because the server gates
 * before reading the stored row; do not add a client-side cache or special retry for that gap.
 */
/** A 202 races reconciliation, so poll briefly and never stop early on an identical row (#2034). */
const REFRESH_POLL_INTERVAL_MS = 700;
const REFRESH_POLL_WINDOW_MS = 5_000;

/** Keep fast 202 responses visibly active without pretending the full poll window is request time. */
const REFRESH_MIN_SPIN_MS = 800;

export function CompanionEbookSection({ bookId }: { bookId: number }) {
  const queryClient = useQueryClient();
  const [pollUntil, setPollUntil] = useState<number | null>(null);

  // Disabled clicks prevent overlap, so an unconditional timer is safe. Deadline checks can
  // strand the latch if the wall clock moves backward; revisit only if the disabled rule changes.
  const [minSpinning, setMinSpinning] = useState(false);
  const startMinSpin = () => {
    setMinSpinning(true);
    window.setTimeout(() => setMinSpinning(false), REFRESH_MIN_SPIN_MS);
  };

  const { data, error } = useQuery({
    queryKey: queryKeys.companionEbook(bookId),
    queryFn: () => api.getCompanionEbookState(bookId),
    // Every mount must re-check so a disable cannot remain hidden behind the 60s app default.
    staleTime: 0,
    // Function form lets react-query close the window after a fetch without a render-time clock read.
    refetchInterval: () =>
      pollUntil !== null && Date.now() < pollUntil ? REFRESH_POLL_INTERVAL_MS : false,
    // A 409 must hide cached controls immediately after the feature is disabled.
    retry: retryUnlessDisabled,
  });

  const chapterCount = useCompanionChapterCount(bookId, data);

  // Toasts and cache invalidation remain valid after navigation; unmounted state writes are no-ops.
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

  // Layout cleanup runs before an unkeyed BookDetails commits the next book, closing the stale
  // selection/toast window that a passive cleanup would leave (AC24/AC26).
  const { reset } = selection;
  useLayoutEffect(() => reset, [bookId, reset]);

  if (!data) return null;
  if (error instanceof ApiError && error.status === 409) return null;

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          {SECTION_HEADING}
        </h2>
        <div className="flex items-center gap-2">
          <HeaderDownload bookId={bookId} status={data.status} />
          {/* Every state can carry a stale verdict, including none, DRM, and invalid (#2034). */}
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
        {/* Available is self-evident; every exceptional state needs an explicit badge. */}
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
