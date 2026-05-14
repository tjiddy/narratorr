import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, ApiError, type SuggestionRow, type CreateBookPayload } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { getErrorMessage } from '@/lib/error-message.js';
import { useBookStats } from '@/hooks/useLibrary';
import { RefreshIcon, LoadingSpinner } from '@/components/icons';
import { ErrorState } from '@/components/ErrorState.js';
import { PageHeader } from '@/components/PageHeader.js';
import { SUGGESTION_REASONS, SUGGESTION_REASON_REGISTRY, type SuggestionReason } from '../../../shared/schemas/discovery.js';
import { SuggestionCard } from './SuggestionCard.js';
import { DiscoverEmpty } from './DiscoverEmpty.js';
import { DiscoverSkeleton } from './DiscoverSkeleton.js';
import { parseWordList, matchesRejectWord } from '../../../shared/parse-word-list.js';

type ReasonFilter = 'all' | SuggestionReason;

const FILTER_OPTIONS: { value: ReasonFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  ...SUGGESTION_REASONS.map((r) => ({ value: r as ReasonFilter, label: SUGGESTION_REASON_REGISTRY[r].label })),
];

/** Build a CreateBookPayload from a suggestion row (inline, not via mapBookMetadataToPayload). */
function suggestionToPayload(
  s: SuggestionRow,
  overrides: { searchImmediately: boolean },
): CreateBookPayload {
  return {
    title: s.title,
    authors: [{ name: s.authorName, asin: s.authorAsin ?? undefined }],
    narrators: s.narratorName ? [s.narratorName] : undefined,
    coverUrl: s.coverUrl ?? undefined,
    asin: s.asin,
    seriesName: s.seriesName ?? undefined,
    seriesPosition: s.seriesPosition ?? undefined,
    duration: s.duration ?? undefined,
    publishedDate: s.publishedDate ?? undefined,
    genres: s.genres ?? undefined,
    searchImmediately: overrides.searchImmediately,
  };
}

function useDiscoverMutations(setAddedIds: React.Dispatch<React.SetStateAction<Set<number>>>) {
  const queryClient = useQueryClient();
  const [removedIds, setRemovedIds] = useState<Set<number>>(new Set());

  const markAdded = (id: number) => {
    setAddedIds((prev) => new Set(prev).add(id));
    queryClient.invalidateQueries({ queryKey: queryKeys.books() });
    queryClient.invalidateQueries({ queryKey: queryKeys.bookStats() });
    // Fire-and-forget: mark suggestion as added in backend
    api.markDiscoverSuggestionAdded(id).catch(() => {});
  };

  const addMutation = useMutation({
    mutationFn: ({ suggestion, overrides }: { suggestion: SuggestionRow; overrides: { searchImmediately: boolean } }) =>
      api.addBook(suggestionToPayload(suggestion, overrides)),
    onSuccess: (_data, { suggestion }) => {
      markAdded(suggestion.id);
      toast.success('Added to library');
    },
    onError: (error: Error, { suggestion }) => {
      if (error instanceof ApiError && error.status === 409) {
        markAdded(suggestion.id);
        toast.info('Already in library');
      } else {
        toast.error(`Failed to add book: ${getErrorMessage(error)}`);
      }
    },
  });

  const dismissMutation = useMutation({
    mutationFn: (id: number) => api.dismissDiscoverSuggestion(id),
    onMutate: (id) => { setRemovedIds((prev) => new Set(prev).add(id)); },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.discover.suggestions() });
      toast.success('Suggestion dismissed');
    },
    onError: (_err, id) => {
      setRemovedIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
      toast.error('Failed to dismiss suggestion');
    },
  });

  const refreshMutation = useMutation({
    mutationFn: () => api.refreshDiscover(),
    onSuccess: () => {
      setRemovedIds(new Set());
      setAddedIds(new Set());
      queryClient.invalidateQueries({ queryKey: queryKeys.discover.suggestions() });
      queryClient.invalidateQueries({ queryKey: queryKeys.discover.stats() });
      toast.success('Suggestions refreshed');
    },
    onError: () => {
      toast.error('Failed to refresh suggestions');
    },
  });

  return { addMutation, dismissMutation, refreshMutation, removedIds };
}

export function DiscoverPage() {
  const [filter, setFilter] = useState<ReasonFilter>('all');

  const { data: suggestions, isLoading, isError } = useQuery({
    queryKey: queryKeys.discover.suggestions(),
    queryFn: api.getDiscoverSuggestions,
    staleTime: 30_000,
  });

  const { data: settings } = useQuery({
    queryKey: queryKeys.settings(),
    queryFn: api.getSettings,
  });

  const { data: stats } = useBookStats();
  const totalBooks = stats
    ? Object.values(stats.counts).reduce((sum, n) => sum + n, 0)
    : undefined;

  // Client-side language and reject-word filtering
  const configuredLanguages = useMemo(() => settings?.metadata?.languages ?? [], [settings]);
  const rejectWords = useMemo(() => parseWordList(settings?.quality?.rejectWords ?? ''), [settings]);

  const filtered = useMemo(() => {
    if (!suggestions) return [];
    let result = suggestions;
    if (filter !== 'all') result = result.filter((s) => s.reason === filter);
    if (configuredLanguages.length > 0) {
      const langSet = new Set(configuredLanguages.map((l) => l.toLowerCase()));
      result = result.filter((s) => !s.language || langSet.has(s.language.toLowerCase()));
    }
    if (rejectWords.length > 0) {
      result = result.filter((s) => {
        const surface = s.title.toLowerCase();
        return !rejectWords.some((w) => matchesRejectWord(surface, w));
      });
    }
    return result;
  }, [suggestions, filter, configuredLanguages, rejectWords]);

  const [addedIds, setAddedIds] = useState<Set<number>>(new Set());
  const { addMutation, dismissMutation, refreshMutation, removedIds } = useDiscoverMutations(setAddedIds);

  const visibleSuggestions = useMemo(
    () => filtered.filter((s) => !removedIds.has(s.id)),
    [filtered, removedIds],
  );

  if (isLoading) {
    return (
      <div>
        <DiscoverHeader count={0} filter={filter} onFilterChange={setFilter} />
        <DiscoverSkeleton />
      </div>
    );
  }

  if (isError) {
    return (
      <ErrorState
        title="Something went wrong"
        description="Failed to load suggestions. Please try again."
        data-testid="discover-error"
      />
    );
  }

  if (totalBooks === 0) {
    return <DiscoverEmpty variant="no-library" />;
  }

  if (!suggestions || suggestions.length === 0) {
    return (
      <div>
        <DiscoverHeader
          count={0}
          filter={filter}
          onFilterChange={setFilter}
          onRefresh={() => refreshMutation.mutate()}
          isRefreshing={refreshMutation.isPending}
        />
        <DiscoverEmpty variant="no-suggestions" />
      </div>
    );
  }

  return (
    <div>
      <DiscoverHeader
        count={visibleSuggestions.length}
        filter={filter}
        onFilterChange={setFilter}
        onRefresh={() => refreshMutation.mutate()}
        isRefreshing={refreshMutation.isPending}
      />

      {visibleSuggestions.length === 0 ? (
        <div className="flex flex-col items-center py-12 animate-fade-in" data-testid="no-filter-matches">
          <p className="text-muted-foreground">No suggestions match this filter</p>
        </div>
      ) : (
        <div className="space-y-4">
          {visibleSuggestions.map((suggestion, i) => (
            <SuggestionCard
              key={suggestion.id}
              suggestion={suggestion}
              index={i}
              onAdd={(_id, overrides) => addMutation.mutate({ suggestion, overrides })}
              onDismiss={(id) => dismissMutation.mutate(id)}
              isAdding={addMutation.isPending && addMutation.variables?.suggestion.id === suggestion.id}
              isDismissing={dismissMutation.isPending && dismissMutation.variables === suggestion.id}
              isAdded={addedIds.has(suggestion.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function DiscoverHeader({
  count,
  filter,
  onFilterChange,
  onRefresh,
  isRefreshing,
}: {
  count: number;
  filter: ReasonFilter;
  onFilterChange: (f: ReasonFilter) => void;
  onRefresh?: () => void;
  isRefreshing?: boolean;
}) {
  return (
    <div className="mb-6 sm:mb-8 animate-fade-in-up">
      <div className="flex items-center justify-between mb-4">
        <PageHeader title="Discover" subtitle={`Showing ${count} suggestion${count !== 1 ? 's' : ''}`} />
        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            disabled={isRefreshing}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium bg-primary text-primary-foreground hover:shadow-glow disabled:opacity-50 transition-all duration-200 focus-ring"
          >
            {isRefreshing ? (
              <LoadingSpinner className="w-4 h-4" />
            ) : (
              <RefreshIcon className="w-4 h-4" />
            )}
            Refresh
          </button>
        )}
      </div>

      {/* Filter Chips */}
      <div className="flex flex-wrap gap-2">
        {FILTER_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => onFilterChange(opt.value)}
            className={`px-3.5 py-1.5 rounded-xl text-sm font-medium transition-all duration-200 ${
              filter === opt.value
                ? 'bg-primary text-primary-foreground shadow-glow'
                : 'glass-card text-muted-foreground hover:text-foreground hover:border-primary/30'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}
