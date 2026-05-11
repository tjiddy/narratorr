import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type BookSeriesCardData, type BookSeriesMemberCard, type RefreshBookSeriesResponse } from '@/lib/api';
import { RefreshIcon, LoadingSpinner } from '@/components/icons';

interface SeriesCardProps {
  bookId: number;
  fallbackSeriesName?: string | null | undefined;
  fallbackSeriesPosition?: number | null | undefined;
}

interface RefreshBanner {
  kind: 'rate_limited' | 'failed';
  text: string;
}

function formatPositionLabel(member: BookSeriesMemberCard): string {
  if (member.positionRaw) return member.positionRaw;
  if (member.position != null) return String(member.position);
  return '—';
}

function buildBanner(latest: RefreshBookSeriesResponse | undefined, series: BookSeriesCardData | null): RefreshBanner | null {
  if (latest?.status === 'rate_limited') {
    return {
      kind: 'rate_limited',
      text: latest.nextFetchAfter
        ? `Provider is rate-limited. Retry after ${new Date(latest.nextFetchAfter).toLocaleString()}.`
        : 'Provider is rate-limited. Please try again later.',
    };
  }
  if (latest?.status === 'failed') {
    return { kind: 'failed', text: latest.error ? `Refresh failed: ${latest.error}` : 'Refresh failed.' };
  }
  if (series?.lastFetchStatus === 'rate_limited' && series.nextFetchAfter) {
    return {
      kind: 'rate_limited',
      text: `Provider is rate-limited. Retry after ${new Date(series.nextFetchAfter).toLocaleString()}.`,
    };
  }
  return null;
}

export function SeriesCard({ bookId, fallbackSeriesName, fallbackSeriesPosition }: SeriesCardProps) {
  const queryClient = useQueryClient();
  const queryKey = ['book', bookId, 'series'] as const;

  const { data, isLoading } = useQuery({
    queryKey,
    queryFn: () => api.getBookSeries(bookId),
  });

  const refresh = useMutation({
    mutationFn: () => api.refreshBookSeries(bookId),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey });
    },
    onSuccess: (response: RefreshBookSeriesResponse) => {
      if (response.status === 'refreshed' && response.series) {
        queryClient.setQueryData(queryKey, { series: response.series });
      } else if (response.status === 'queued') {
        queryClient.invalidateQueries({ queryKey });
      } else if (response.series) {
        queryClient.setQueryData(queryKey, { series: response.series });
      }
    },
  });

  if (isLoading) return null;

  const series = data?.series ?? null;

  // No backend data and no local fallback — render nothing
  if (!series && !fallbackSeriesName) return null;

  const cardSeries: BookSeriesCardData = series ?? {
    id: -1,
    name: fallbackSeriesName!,
    providerSeriesId: null,
    lastFetchedAt: null,
    lastFetchStatus: null,
    nextFetchAfter: null,
    members: [{
      id: -1,
      providerBookId: null,
      title: '',
      positionRaw: fallbackSeriesPosition != null ? String(fallbackSeriesPosition) : null,
      position: fallbackSeriesPosition ?? null,
      isCurrent: true,
      libraryBookId: bookId,
      coverUrl: null,
    }],
  };

  const banner = buildBanner(refresh.data, series);
  const isRefreshing = refresh.isPending;

  return (
    <div data-testid="series-card">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Series
        </h2>
        <button
          type="button"
          onClick={() => refresh.mutate()}
          disabled={isRefreshing}
          aria-label="Refresh series"
          className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
        >
          {isRefreshing ? <LoadingSpinner className="w-4 h-4" /> : <RefreshIcon className="w-4 h-4" />}
        </button>
      </div>
      <div className="glass-card rounded-2xl p-4 space-y-3">
        <p className="text-sm font-medium" data-testid="series-card-name">{cardSeries.name}</p>
        {banner && (
          <p
            className={`text-xs ${banner.kind === 'failed' ? 'text-destructive' : 'text-amber-500'}`}
            data-testid="series-card-banner"
          >
            {banner.text}
          </p>
        )}
        <ul className="divide-y divide-border/40" data-testid="series-card-members">
          {cardSeries.members.length === 0 && (
            <li className="text-xs text-muted-foreground py-2">No members known yet.</li>
          )}
          {cardSeries.members.map((member) => {
            const inLibrary = member.libraryBookId != null;
            return (
              <li
                key={`${member.id}-${member.providerBookId ?? member.title}`}
                className={`flex items-center justify-between py-2 ${member.isCurrent ? 'font-medium' : ''}`}
                data-testid="series-card-member"
                data-is-current={member.isCurrent ? 'true' : 'false'}
                data-in-library={inLibrary ? 'true' : 'false'}
              >
                <span className="flex items-center gap-2 min-w-0">
                  <span className="text-xs text-muted-foreground tabular-nums w-8 shrink-0 text-right">
                    {formatPositionLabel(member)}
                  </span>
                  <span className="text-sm truncate">{member.title || cardSeries.name}</span>
                </span>
                <span
                  className={`text-xs ml-2 shrink-0 ${inLibrary ? 'text-emerald-500' : 'text-muted-foreground'}`}
                >
                  {inLibrary ? 'In Library' : 'Missing'}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
