import { formatBytes, type SearchResult } from '@/lib/api';
import { calculateQuality, compareQuality, qualityTierBg } from '@core/utils/index.js';
// Direct import, not the barrel: the barrel is a mock boundary in tests, and this predicate must
// be the same production code the auto-grab filter runs so the two surfaces cannot disagree.
import { isResultAtUnsatisfiedLimit } from '@core/utils/mam-unsatisfied.js';
import {
  DownloadIcon,
  LoadingSpinner,
  BookOpenIcon,
  HeadphonesIcon,
  AlertTriangleIcon,
  ShieldBanIcon,
} from '@/components/icons';
import { CoverImage } from '@/components/CoverImage';
import { ProtocolBadge } from '@/components/ProtocolBadge';

const BADGE = 'text-xs px-1.5 py-0.5 rounded-md font-medium';

function MetaRow({ result, isInLibrary, quality, comparison }: {
  result: SearchResult;
  isInLibrary: boolean;
  quality: ReturnType<typeof calculateQuality> | null;
  comparison: ReturnType<typeof compareQuality> | null;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2.5 mt-auto pt-2">
      {result.size != null && result.size > 0 && (
        <span className="text-xs text-muted-foreground">{formatBytes(result.size)}</span>
      )}
      {result.seeders !== undefined && (
        <span className="flex items-center gap-1 text-xs text-success">
          <span className="w-1.5 h-1.5 bg-success rounded-full animate-pulse" />
          {result.seeders} seeders
        </span>
      )}
      <ProtocolBadge protocol={result.protocol} />
      {result.isFreeleech && (
        <span className={`${BADGE} bg-emerald-500/10 text-emerald-400 border border-emerald-500/20`}>Freeleech</span>
      )}
      {result.isVipOnly && (
        <span className={`${BADGE} bg-amber-500/10 text-amber-400 border border-amber-500/20`}>VIP</span>
      )}
      <span className={`${BADGE} bg-muted text-muted-foreground`}>{result.indexer}</span>
      {result.format && (
        <span className={`${BADGE} bg-purple-500/10 text-purple-400 border border-purple-500/20`}>{result.format}</span>
      )}
      {result.language && (
        <span className={`${BADGE} bg-blue-500/10 text-blue-400 border border-blue-500/20 capitalize`}>
          {result.language.toLowerCase()}
        </span>
      )}
      {isInLibrary && (
        <span className={`${BADGE} bg-green-500/10 text-green-400 border border-green-500/20`}>In library</span>
      )}
      {quality && (
        <span className={`${BADGE} ${qualityTierBg(quality.tier)}`}>
          {quality.tier} · {quality.mbPerHour} MB/hr
        </span>
      )}
      {comparison === 'lower' && (
        <span className="flex items-center gap-1 text-xs text-yellow-400" title="Your copy is likely better quality">
          <AlertTriangleIcon className="w-3 h-3" />
          Lower quality
        </span>
      )}
    </div>
  );
}

// eslint-disable-next-line complexity -- conditional quality display + action buttons
export function ReleaseCard({
  result,
  bookDurationSeconds,
  existingBookSizeBytes,
  lastGrabGuid,
  lastGrabInfoHash,
  onGrab,
  onBlacklist,
  isGrabbing,
  isBlacklisting,
}: {
  result: SearchResult;
  bookDurationSeconds?: number | undefined;
  existingBookSizeBytes?: number | undefined;
  lastGrabGuid?: string | null | undefined;
  lastGrabInfoHash?: string | null | undefined;
  onGrab: () => void;
  onBlacklist: () => void;
  isGrabbing: boolean;
  isBlacklisting: boolean;
}) {
  const quality = result.size && bookDurationSeconds
    ? calculateQuality(result.size, bookDurationSeconds)
    : null;
  const comparison = existingBookSizeBytes
    ? compareQuality(existingBookSizeBytes, result.size, bookDurationSeconds)
    : null;
  const isInLibrary =
    (!!result.guid && result.guid === lastGrabGuid) ||
    (!!result.infoHash && result.infoHash === lastGrabInfoHash);
  const atLimit = isResultAtUnsatisfiedLimit(result);
  // A missing link is a permanent property of the release, so it outranks the temporary account
  // condition: showing the limit for a linkless release would promise a retry that cannot succeed.
  const atLimitReason = atLimit && result.downloadUrl
    ? `${result.indexer} has it; your account cannot take it right now — ${result.unsatisfied.count} of ${result.unsatisfied.limit} unsatisfied`
    : null;
  return (
    <div className={`glass-card rounded-xl p-4 hover:border-primary/30 transition-all duration-200 overflow-hidden ${
      isInLibrary ? 'border-l-[3px] border-l-green-500 border-green-500/25 bg-gradient-to-r from-green-500/10 via-green-500/[0.03] to-transparent' : ''
    }`}>
      <div className="flex gap-4 overflow-hidden">
        <div className="shrink-0">
          <CoverImage
            src={result.coverUrl}
            alt={result.title}
            className="w-14 h-14 rounded-lg"
            fallback={<BookOpenIcon className="w-6 h-6 text-muted-foreground/40" />}
          />
        </div>

        <div className="flex-1 min-w-0 overflow-hidden flex flex-col">
          {/* Keep the title first so a long author list is truncated, not the title. */}
          <h4 className="font-medium text-sm leading-tight truncate">
            {result.title}
            {result.author && <span className="text-muted-foreground"> — {result.author}</span>}
          </h4>
          {result.rawTitle && (
            <p className="text-xs text-muted-foreground/60 truncate mt-0.5" title={result.rawTitle}>
              {result.rawTitle}
            </p>
          )}
          {result.narrator && (
            <p className="text-xs text-muted-foreground flex items-center gap-1 mt-1 truncate">
              <HeadphonesIcon className="w-3 h-3 shrink-0" />
              <span className="truncate">{result.narrator}</span>
            </p>
          )}
          <MetaRow result={result} isInLibrary={isInLibrary} quality={quality} comparison={comparison} />
        </div>

        <div className="shrink-0 flex flex-col items-end gap-2">
          <button
            type="button"
            onClick={onGrab}
            disabled={!result.downloadUrl || atLimit || isGrabbing}
            {...(atLimitReason !== null && { title: atLimitReason })}
            className="flex items-center gap-1.5 px-3 py-2 text-sm bg-primary text-primary-foreground font-medium rounded-lg hover:opacity-90 hover:shadow-glow disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 focus-ring"
          >
            {isGrabbing ? (
              <LoadingSpinner className="w-3.5 h-3.5" />
            ) : (
              <DownloadIcon className="w-3.5 h-3.5" />
            )}
            Grab
          </button>
          {atLimitReason !== null && (
            <p className="text-xs text-amber-400 text-right max-w-[13rem]">{atLimitReason}</p>
          )}
          <button
            type="button"
            onClick={onBlacklist}
            disabled={(!result.infoHash && !result.guid) || isBlacklisting}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-destructive disabled:opacity-50 disabled:cursor-not-allowed transition-colors focus-ring rounded px-1.5 py-1"
            title={(result.infoHash || result.guid) ? 'Blacklist this release' : 'No identifier available'}
          >
            {isBlacklisting ? (
              <LoadingSpinner className="w-3 h-3" />
            ) : (
              <ShieldBanIcon className="w-3 h-3" />
            )}
            Blacklist
          </button>
        </div>
      </div>
    </div>
  );
}
