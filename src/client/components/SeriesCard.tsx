import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import {
  api,
  ApiError,
  type BookSeriesCardData,
  type BookSeriesMemberCard,
  type CreateBookPayload,
  type RefreshBookSeriesResponse,
} from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { getErrorMessage } from '@/lib/error-message.js';
import { AddBookPopover } from '@/components/AddBookPopover';
import { RefreshIcon, LoadingSpinner, PlusIcon } from '@/components/icons';

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

function buildCreatePayload(
  member: BookSeriesMemberCard,
  cardSeries: BookSeriesCardData,
  overrides: { searchImmediately: boolean; monitorForUpgrades: boolean },
): CreateBookPayload {
  return {
    title: member.title,
    asin: member.providerBookId ?? undefined,
    authors: member.authorName ? [{ name: member.authorName }] : undefined,
    seriesName: cardSeries.name,
    seriesPosition: member.position ?? undefined,
    seriesAsin: cardSeries.providerSeriesId ?? undefined,
    seriesProvider: 'audible',
    coverUrl: member.coverUrl ?? undefined,
    publishedDate: member.publishedDate ?? undefined,
    duration: member.duration ?? undefined,
    searchImmediately: overrides.searchImmediately,
    monitorForUpgrades: overrides.monitorForUpgrades,
  };
}

function canAddMember(member: BookSeriesMemberCard): boolean {
  return member.providerBookId != null && member.authorName != null;
}

function buildFallbackCard(
  bookId: number,
  fallbackSeriesName: string,
  fallbackSeriesPosition: number | null | undefined,
): BookSeriesCardData {
  const position = fallbackSeriesPosition ?? null;
  return {
    id: -1,
    name: fallbackSeriesName,
    providerSeriesId: null,
    lastFetchedAt: null,
    lastFetchStatus: null,
    nextFetchAfter: null,
    members: [{
      id: -1,
      providerBookId: null,
      title: '',
      positionRaw: position != null ? String(position) : null,
      position,
      isCurrent: true,
      libraryBookId: bookId,
      coverUrl: null,
      authorName: null,
      publishedDate: null,
      duration: null,
    }],
  };
}

function memberKeyFor(member: BookSeriesMemberCard): string {
  return `${member.id}-${member.providerBookId ?? member.title}`;
}

interface AddRowControlProps {
  member: BookSeriesMemberCard;
  onAdd: (overrides: { searchImmediately: boolean; monitorForUpgrades: boolean }) => void;
  isPending: boolean;
}

function AddRowControl({ member, onAdd, isPending }: AddRowControlProps) {
  if (!canAddMember(member)) {
    const reason = member.providerBookId == null
      ? 'Missing provider ID — refresh the series to enable Add.'
      : 'Missing author — refresh the series to enable Add.';
    return (
      <button
        type="button"
        disabled
        aria-label="Add book (unavailable)"
        title={reason}
        data-testid="series-card-add-disabled"
        className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-md text-muted-foreground/60 opacity-50 cursor-not-allowed"
      >
        <PlusIcon className="w-3 h-3" />
        Add
      </button>
    );
  }
  return <AddBookPopover variant="compact" onAdd={onAdd} isPending={isPending} />;
}

interface MemberRowProps {
  member: BookSeriesMemberCard;
  cardSeries: BookSeriesCardData;
  onAdd: (member: BookSeriesMemberCard, overrides: { searchImmediately: boolean; monitorForUpgrades: boolean }) => void;
  pendingMemberKey: string | null;
}

function MemberRow({ member, cardSeries, onAdd, pendingMemberKey }: MemberRowProps) {
  const inLibrary = member.libraryBookId != null;
  const isPending = pendingMemberKey === memberKeyFor(member);
  const titleNode = (member.title || cardSeries.name);
  return (
    <li
      className={`flex items-center justify-between py-2 ${member.isCurrent ? 'font-medium' : ''}`}
      data-testid="series-card-member"
      data-is-current={member.isCurrent ? 'true' : 'false'}
      data-in-library={inLibrary ? 'true' : 'false'}
    >
      <span className="flex items-center gap-2 min-w-0">
        <span className="text-xs text-muted-foreground tabular-nums w-8 shrink-0 text-right">
          {formatPositionLabel(member)}
        </span>
        {inLibrary ? (
          <Link
            to={`/books/${member.libraryBookId}`}
            className="text-sm truncate text-foreground hover:text-primary transition-colors"
            data-testid="series-card-member-link"
          >
            {titleNode}
          </Link>
        ) : (
          <span className="text-sm truncate">{titleNode}</span>
        )}
      </span>
      <span className="ml-2 shrink-0">
        {inLibrary ? (
          <span className="text-xs text-emerald-500">In Library</span>
        ) : (
          <AddRowControl
            member={member}
            onAdd={(overrides) => onAdd(member, overrides)}
            isPending={isPending}
          />
        )}
      </span>
    </li>
  );
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

  const addMember = useMutation({
    mutationFn: (payload: { memberKey: string; body: CreateBookPayload }) => api.addBook(payload.body),
    onSuccess: (_data, payload) => {
      toast.success(`Added '${payload.body.title}' to library`);
      queryClient.invalidateQueries({ queryKey: queryKeys.books() });
      queryClient.invalidateQueries({ queryKey: queryKeys.bookStats() });
      queryClient.invalidateQueries({ queryKey });
    },
    onError: (error: Error, payload) => {
      // 409 = book already exists. Match the SearchBookCard/DiscoverPage pattern:
      // surface a neutral "Already in library" toast and still invalidate the
      // book + series caches so the row flips to In Library without a refresh.
      if (error instanceof ApiError && error.status === 409) {
        toast.info(`'${payload.body.title}' is already in library`);
        queryClient.invalidateQueries({ queryKey: queryKeys.books() });
        queryClient.invalidateQueries({ queryKey: queryKeys.bookStats() });
        queryClient.invalidateQueries({ queryKey });
        return;
      }
      toast.error(`Failed to add '${payload.body.title}': ${getErrorMessage(error)}`);
    },
  });

  if (isLoading) return null;

  const series = data?.series ?? null;

  if (!series && !fallbackSeriesName) return null;

  const cardSeries: BookSeriesCardData = series ?? buildFallbackCard(bookId, fallbackSeriesName!, fallbackSeriesPosition);

  const banner = buildBanner(refresh.data, series);
  const isRefreshing = refresh.isPending;
  const pendingMemberKey = addMember.isPending ? (addMember.variables?.memberKey ?? null) : null;

  const handleAdd = (member: BookSeriesMemberCard, overrides: { searchImmediately: boolean; monitorForUpgrades: boolean }) => {
    if (!canAddMember(member)) return;
    addMember.mutate({ memberKey: memberKeyFor(member), body: buildCreatePayload(member, cardSeries, overrides) });
  };

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
          {cardSeries.members.map((member) => (
            <MemberRow
              key={memberKeyFor(member)}
              member={member}
              cardSeries={cardSeries}
              onAdd={handleAdd}
              pendingMemberKey={pendingMemberKey}
            />
          ))}
        </ul>
      </div>
    </div>
  );
}
