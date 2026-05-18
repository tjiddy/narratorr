import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  api,
  type BookSeriesCardData,
  type BookSeriesMemberCard,
  type RefreshBookSeriesResponse,
} from '@/lib/api';
import { RefreshIcon, LoadingSpinner } from '@/components/icons';

interface SeriesCardProps {
  bookId: number;
}

function formatPositionLabel(member: BookSeriesMemberCard): string {
  if (member.position != null) return String(member.position);
  return '—';
}

function buildAddSearchHref(member: BookSeriesMemberCard, card: BookSeriesCardData): string {
  const author = card.seriesAuthor ?? '';
  const q = `${member.title} ${author}`.trim();
  return `/search?q=${encodeURIComponent(q)}`;
}

function memberKeyFor(member: BookSeriesMemberCard, index: number): string {
  if (member.hardcoverBookId !== null) return `hardcover-${member.hardcoverBookId}`;
  if (member.libraryBookId !== null) return `library-${member.libraryBookId}`;
  return `t-${member.title}-${index}`;
}

interface MemberRowProps {
  member: BookSeriesMemberCard;
  card: BookSeriesCardData;
}

function MemberRow({ member, card }: MemberRowProps) {
  return (
    <li
      className="flex items-center justify-between py-2"
      data-testid="series-card-member"
      data-in-library={member.inLibrary ? 'true' : 'false'}
    >
      <span className="flex items-center gap-2 min-w-0">
        <span className="text-xs text-muted-foreground tabular-nums w-8 shrink-0 text-right">
          {formatPositionLabel(member)}
        </span>
        {member.inLibrary && member.libraryBookId !== null ? (
          <Link
            to={`/books/${member.libraryBookId}`}
            className="text-sm truncate text-foreground hover:text-primary transition-colors"
            data-testid="series-card-member-link"
          >
            {member.title}
          </Link>
        ) : (
          <span className="text-sm truncate">{member.title}</span>
        )}
      </span>
      <span className="ml-2 shrink-0">
        {member.inLibrary ? (
          <span className="text-xs text-emerald-500">In Library</span>
        ) : (
          <Link
            to={buildAddSearchHref(member, card)}
            className="text-xs px-2 py-0.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            data-testid="series-card-add"
          >
            + Add
          </Link>
        )}
      </span>
    </li>
  );
}

export function SeriesCard({ bookId }: SeriesCardProps) {
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
      queryClient.setQueryData(queryKey, { series: response.series });
    },
  });

  if (isLoading) return null;

  const series = data?.series ?? null;
  if (!series) return null;

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
        <p className="text-sm font-medium" data-testid="series-card-name">{series.name}</p>
        <ul className="divide-y divide-border/40" data-testid="series-card-members">
          {series.members.length === 0 && (
            <li className="text-xs text-muted-foreground py-2">No members known yet.</li>
          )}
          {series.members.map((member, idx) => (
            <MemberRow
              key={memberKeyFor(member, idx)}
              member={member}
              card={series}
            />
          ))}
        </ul>
      </div>
    </div>
  );
}
