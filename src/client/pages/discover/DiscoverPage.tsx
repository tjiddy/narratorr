import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { useBookStats } from '@/hooks/useLibrary';
import { RefreshIcon, LoadingSpinner, AlertCircleIcon } from '@/components/icons';
import { SUGGESTION_REASONS, SUGGESTION_REASON_REGISTRY, type SuggestionReason } from '../../../shared/schemas/discovery.js';
import { SuggestionCard } from './SuggestionCard.js';
import { DiscoverEmpty } from './DiscoverEmpty.js';
import { DiscoverSkeleton } from './DiscoverSkeleton.js';

type ReasonFilter = 'all' | SuggestionReason;

const FILTER_OPTIONS: { value: ReasonFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  ...SUGGESTION_REASONS.map((r) => ({ value: r as ReasonFilter, label: SUGGESTION_REASON_REGISTRY[r].label })),
];

export function DiscoverPage() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<ReasonFilter>('all');

  const { data: suggestions, isLoading, isError } = useQuery({
    queryKey: queryKeys.discover.suggestions(),
    queryFn: api.getDiscoverSuggestions,
    staleTime: 30_000,
  });

  const { data: stats } = useBookStats();
  const totalBooks = stats
    ? Object.values(stats.counts).reduce((sum, n) => sum + n, 0)
    : undefined;

  const filtered = useMemo(() => {
    if (!suggestions) return [];
    if (filter === 'all') return suggestions;
    return suggestions.filter((s) => s.reason === filter);
  }, [suggestions, filter]);

  // Track optimistically removed IDs
  const [removedIds, setRemovedIds] = useState<Set<number>>(new Set());

  const visibleSuggestions = useMemo(
    () => filtered.filter((s) => !removedIds.has(s.id)),
    [filtered, removedIds],
  );

  function optimisticRemove(id: number) {
    setRemovedIds((prev) => new Set(prev).add(id));
  }

  function optimisticRestore(id: number) {
    setRemovedIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  const addMutation = useMutation({
    mutationFn: (id: number) => api.addDiscoverSuggestion(id),
    onMutate: (id) => optimisticRemove(id),
    onSuccess: (_data, _id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.discover.suggestions() });
      queryClient.invalidateQueries({ queryKey: queryKeys.books() });
      queryClient.invalidateQueries({ queryKey: queryKeys.bookStats() });
      toast.success('Added to library');
    },
    onError: (_err, id) => {
      optimisticRestore(id);
      toast.error('Failed to add suggestion');
    },
  });

  const dismissMutation = useMutation({
    mutationFn: (id: number) => api.dismissDiscoverSuggestion(id),
    onMutate: (id) => optimisticRemove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.discover.suggestions() });
      toast.success('Suggestion dismissed');
    },
    onError: (_err, id) => {
      optimisticRestore(id);
      toast.error('Failed to dismiss suggestion');
    },
  });

  const refreshMutation = useMutation({
    mutationFn: () => api.refreshDiscover(),
    onSuccess: () => {
      setRemovedIds(new Set());
      queryClient.invalidateQueries({ queryKey: queryKeys.discover.suggestions() });
      queryClient.invalidateQueries({ queryKey: queryKeys.discover.stats() });
      toast.success('Suggestions refreshed');
    },
    onError: () => {
      toast.error('Failed to refresh suggestions');
    },
  });

  if (isLoading) {
    return (
      <div>
        <PageHeader count={0} filter={filter} onFilterChange={setFilter} />
        <DiscoverSkeleton />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-col items-center justify-center py-16 sm:py-24 text-center animate-fade-in-up" data-testid="discover-error">
        <div className="relative mb-8">
          <div className="absolute inset-0 bg-destructive/20 rounded-full blur-2xl" />
          <div className="relative p-6 bg-gradient-to-br from-destructive/10 to-red-500/10 rounded-full">
            <AlertCircleIcon className="w-16 h-16 text-destructive" />
          </div>
        </div>
        <h3 className="font-display text-2xl sm:text-3xl font-semibold mb-3">Something went wrong</h3>
        <p className="text-muted-foreground max-w-md">Failed to load suggestions. Please try again.</p>
      </div>
    );
  }

  if (totalBooks === 0) {
    return <DiscoverEmpty variant="no-library" />;
  }

  if (!suggestions || suggestions.length === 0) {
    return (
      <div>
        <PageHeader
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
      <PageHeader
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
              onAdd={(id) => addMutation.mutate(id)}
              onDismiss={(id) => dismissMutation.mutate(id)}
              isAdding={addMutation.isPending && addMutation.variables === suggestion.id}
              isDismissing={dismissMutation.isPending && dismissMutation.variables === suggestion.id}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function PageHeader({
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
        <div>
          <h1 className="font-display text-3xl sm:text-4xl font-bold tracking-tight">Discover</h1>
          <p className="text-muted-foreground mt-1" data-testid="suggestion-count">
            Showing {count} suggestion{count !== 1 ? 's' : ''}
          </p>
        </div>
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
