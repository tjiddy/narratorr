import { formatBytes, type SearchResult } from '@/lib/api';
import { calculateQuality, compareQuality, qualityTierBg } from '@core/utils/index.js';
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
  bookDurationSeconds?: number;
  existingBookSizeBytes?: number;
  lastGrabGuid?: string | null;
  lastGrabInfoHash?: string | null;
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
  return (
    <div className="glass-card rounded-xl p-4 hover:border-primary/30 transition-all duration-200 overflow-hidden">
      <div className="flex gap-4 overflow-hidden">
        {/* Cover */}
        <div className="shrink-0">
          <CoverImage
            src={result.coverUrl}
            alt={result.title}
            className="w-14 h-14 rounded-lg"
            fallback={<BookOpenIcon className="w-6 h-6 text-muted-foreground/40" />}
          />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0 overflow-hidden flex flex-col">
          <h4 className="font-medium text-sm leading-tight truncate">
            {result.author && <span className="text-muted-foreground">{result.author} — </span>}
            {result.title}
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
              <span className="text-xs px-1.5 py-0.5 rounded-md font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                Freeleech
              </span>
            )}
            {result.isVipOnly && (
              <span className="text-xs px-1.5 py-0.5 rounded-md font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20">
                VIP
              </span>
            )}
            <span className="text-xs px-1.5 py-0.5 bg-muted rounded-md font-medium text-muted-foreground">
              {result.indexer}
            </span>
            {result.language && (
              <span className="text-xs px-1.5 py-0.5 rounded-md font-medium bg-blue-500/10 text-blue-400 border border-blue-500/20 capitalize">
                {result.language.toLowerCase()}
              </span>
            )}
            {isInLibrary && (
              <span className="text-xs px-1.5 py-0.5 rounded-md font-medium bg-green-500/10 text-green-400 border border-green-500/20">
                In library
              </span>
            )}
            {quality && (
              <span className={`text-xs px-1.5 py-0.5 rounded-md font-medium ${qualityTierBg(quality.tier)}`}>
                {quality.tier} · {quality.mbPerHour} MB/hr
              </span>
            )}
            {comparison === 'lower' && (
              <span
                className="flex items-center gap-1 text-xs text-yellow-400"
                title="Your copy is likely better quality"
              >
                <AlertTriangleIcon className="w-3 h-3" />
                Lower quality
              </span>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="shrink-0 flex flex-col items-end gap-2">
          <button
            type="button"
            onClick={onGrab}
            disabled={!result.downloadUrl || isGrabbing}
            className="flex items-center gap-1.5 px-3 py-2 text-sm bg-primary text-primary-foreground font-medium rounded-lg hover:opacity-90 hover:shadow-glow disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 focus-ring"
          >
            {isGrabbing ? (
              <LoadingSpinner className="w-3.5 h-3.5" />
            ) : (
              <DownloadIcon className="w-3.5 h-3.5" />
            )}
            Grab
          </button>
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
