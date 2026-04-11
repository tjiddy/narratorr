import { CoverImage } from '@/components/CoverImage';
import { formatDurationMinutes } from '@/lib/format';
import type { SuggestionRow } from '@/lib/api';
import {
  BookOpenIcon,
  HeadphonesIcon,
  ClockIcon,
  PlusIcon,
  XIcon,
} from '@/components/icons';

export function SuggestionCard({
  suggestion,
  index,
  onAdd,
  onDismiss,
  isAdding,
  isDismissing,
}: {
  suggestion: SuggestionRow;
  index: number;
  onAdd: (id: number) => void;
  onDismiss: (id: number) => void;
  isAdding: boolean;
  isDismissing: boolean;
}) {
  const durationText = suggestion.duration ? formatDurationMinutes(Math.round(suggestion.duration / 60)) : null;
  const seriesTag =
    suggestion.seriesName
      ? `${suggestion.seriesName}${suggestion.seriesPosition != null ? `, Book ${suggestion.seriesPosition}` : ''}`
      : null;

  return (
    <div
      className="group glass-card rounded-2xl p-4 sm:p-5 hover:shadow-card-hover hover:border-primary/30 transition-all duration-300 ease-out animate-fade-in-up"
      style={{ animationDelay: `${Math.min(index, 9) * 50}ms` }}
    >
      <div className="flex gap-4 sm:gap-5">
        {/* Cover Image */}
        <div className="shrink-0">
          <CoverImage
            src={suggestion.coverUrl}
            alt={suggestion.title}
            className="w-20 h-28 sm:w-24 sm:h-32 rounded-xl shadow-card"
            fallback={<BookOpenIcon className="w-8 h-8 text-muted-foreground/40" />}
          />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0 flex flex-col">
          <h3 className="font-display text-lg sm:text-xl font-semibold line-clamp-2 group-hover:text-primary transition-colors">
            {suggestion.title}
          </h3>

          <p className="text-muted-foreground mt-1">
            by <span className="text-foreground font-medium">{suggestion.authorName}</span>
          </p>

          {suggestion.narratorName && (
            <p className="text-sm text-muted-foreground flex items-center gap-1.5 mt-0.5">
              <HeadphonesIcon className="w-3.5 h-3.5" />
              Narrated by {suggestion.narratorName}
            </p>
          )}

          {/* Metadata row */}
          <div className="flex flex-wrap items-center gap-2 sm:gap-3 mt-auto pt-3">
            {seriesTag && (
              <span className="text-xs sm:text-sm px-2 py-0.5 rounded-md bg-amber-500/10 text-amber-700 dark:text-amber-400/90 font-medium">
                {seriesTag}
              </span>
            )}
            {durationText && (
              <span className="flex items-center gap-1 text-xs sm:text-sm text-muted-foreground">
                <ClockIcon className="w-3.5 h-3.5" />
                {durationText}
              </span>
            )}
            {suggestion.reasonContext && (
              <span className="text-xs px-2 py-0.5 rounded-md bg-primary/8 text-primary font-medium">
                {suggestion.reasonContext}
              </span>
            )}
          </div>
        </div>

        {/* Action Buttons */}
        <div className="shrink-0 flex flex-col items-center gap-2 justify-center">
          <button
            type="button"
            onClick={() => onAdd(suggestion.id)}
            disabled={isAdding || isDismissing}
            className="flex items-center gap-1.5 px-3 sm:px-4 py-2 rounded-xl text-sm font-medium bg-primary text-primary-foreground hover:shadow-glow disabled:opacity-50 transition-all duration-200 focus-ring"
            aria-label={`Add ${suggestion.title} to library`}
          >
            <PlusIcon className="w-4 h-4" />
            <span className="hidden sm:inline">Add</span>
          </button>
          <button
            type="button"
            onClick={() => onDismiss(suggestion.id)}
            disabled={isAdding || isDismissing}
            className="flex items-center gap-1.5 px-3 sm:px-4 py-2 rounded-xl text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-50 transition-all duration-200 focus-ring"
            aria-label={`Dismiss ${suggestion.title}`}
          >
            <XIcon className="w-4 h-4" />
            <span className="hidden sm:inline">Dismiss</span>
          </button>
        </div>
      </div>
    </div>
  );
}
