import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { toast } from 'sonner';
import {
  api,
  type AddAllSeriesResponse,
  type BookSeriesCardData,
  type BookSeriesMemberCard,
  type RefreshBookSeriesResponse,
} from '@/lib/api';
import { selectAddAllMembers } from '@shared/series-add-all.js';
import { queryKeys } from '@/lib/queryKeys';
import { useGenerationGuard, type GenerationContext } from '@/hooks/useGenerationGuard';
import { RefreshIcon, LoadingSpinner, PencilIcon } from '@/components/icons';
import { AddBookPopover } from '@/components/AddBookPopover';
import { FixSeriesModal } from '@/components/book/FixSeriesModal';

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

function bookNoun(count: number): string {
  return count === 1 ? '1 book' : `${count} books`;
}

/** Name every non-empty bucket: a batch that partly held or failed must not read as a clean success. */
function summarizeBatch(result: AddAllSeriesResponse): string {
  const parts = [`${result.created} added`];
  if (result.owned > 0) parts.push(`${result.owned} already owned`);
  if (result.held > 0) parts.push(`${result.held} held for review`);
  if (result.failed > 0) parts.push(`${result.failed} failed`);
  return parts.join(' · ');
}

interface AddAllControlProps {
  bookId: number;
  count: number;
}

function AddAllControl({ bookId, count }: AddAllControlProps) {
  const queryClient = useQueryClient();

  // Hook-level mutation callbacks still fire after unmount; the guard suppresses lifecycle-local
  // effects while shared caches are still reconciled.
  const { capture, isLive } = useGenerationGuard();

  const addAll = useMutation({
    mutationFn: (searchImmediately: boolean) => api.addAllInSeries(bookId, searchImmediately),
    onMutate: capture,
    onSuccess: (result: AddAllSeriesResponse, _vars, context: GenerationContext) => {
      // bookSeries is not a child of books, so the card would keep showing '+ Add' without it.
      queryClient.invalidateQueries({ queryKey: queryKeys.books() });
      queryClient.invalidateQueries({ queryKey: queryKeys.bookIdentifiers() });
      queryClient.invalidateQueries({ queryKey: queryKeys.bookSeries(bookId) });
      if (!isLive(context)) return;
      const summary = summarizeBatch(result);
      // `owned` and `held` are durable successes — an idempotent rerun or a stale card legitimately
      // creates nothing — so only a run that added nothing AND failed something is error-shaped.
      if (result.created === 0 && result.failed > 0) toast.error(summary);
      else toast.success(summary);
    },
    onError: (_error, _vars, context) => {
      if (!isLive(context)) return;
      toast.error('Failed to add the series to your library');
    },
  });

  return (
    <AddBookPopover
      variant="compact"
      isPending={addAll.isPending}
      triggerLabel={`Add All (${count})`}
      triggerAriaLabel="Add all books in series"
      confirmLabel={`Add ${bookNoun(count)}`}
      onAdd={({ searchImmediately }) => addAll.mutate(searchImmediately)}
    />
  );
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
          member.libraryBookId !== null ? (
            <Link
              to={`/books/${member.libraryBookId}`}
              className="text-xs text-emerald-500 hover:underline focus-ring rounded"
              data-testid="series-card-member-badge-link"
            >
              In Library
            </Link>
          ) : (
            <span className="text-xs text-emerald-500">In Library</span>
          )
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
  const queryKey = queryKeys.bookSeries(bookId);
  const [isFixOpen, setIsFixOpen] = useState(false);

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
  // Derived, so the label cannot drift from the set the server will build.
  const addAllCount = selectAddAllMembers(series.members).length;

  return (
    <div data-testid="series-card">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Series
        </h2>
        <div className="flex items-center gap-2">
          {addAllCount > 0 && <AddAllControl bookId={bookId} count={addAllCount} />}
          <button
            type="button"
            onClick={() => setIsFixOpen(true)}
            aria-label="Fix series match"
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            <PencilIcon className="w-4 h-4" />
          </button>
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
      {isFixOpen && (
        <FixSeriesModal
          bookId={bookId}
          currentSeriesName={series.name}
          onClose={() => setIsFixOpen(false)}
        />
      )}
    </div>
  );
}
