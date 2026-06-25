import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, type HardcoverSeriesCandidate, type RefreshBookSeriesResponse } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { getErrorMessage } from '@/lib/error-message.js';
import { XIcon, SearchIcon, LoadingSpinner, BookOpenIcon } from '@/components/icons';
import { Modal } from '@/components/Modal';
import { resolveCoverUrl } from '@/lib/url-utils';

interface FixSeriesModalProps {
  bookId: number;
  currentSeriesName: string;
  onClose: () => void;
}

function CandidateRow({ candidate, onSelect, disabled }: { candidate: HardcoverSeriesCandidate; onSelect: () => void; disabled: boolean }) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        disabled={disabled}
        data-testid="fix-series-candidate"
        className="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-left hover:bg-muted transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <span className="shrink-0 w-10 h-14 rounded-md overflow-hidden bg-muted flex items-center justify-center ring-1 ring-white/[0.08]">
          {candidate.imageUrl ? (
            <img src={resolveCoverUrl(candidate.imageUrl, undefined)} alt={`Cover of ${candidate.name}`} className="w-full h-full object-cover" />
          ) : (
            <BookOpenIcon className="w-5 h-5 text-muted-foreground/30" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium truncate">{candidate.name}</span>
          <span className="block text-xs text-muted-foreground truncate">
            {candidate.authorName ? `${candidate.authorName} · ` : ''}
            {candidate.booksCount} {candidate.booksCount === 1 ? 'book' : 'books'}
          </span>
        </span>
      </button>
    </li>
  );
}

export function FixSeriesModal({ bookId, currentSeriesName, onClose }: FixSeriesModalProps) {
  const queryClient = useQueryClient();
  const seriesQueryKey = queryKeys.bookSeries(bookId);
  const [query, setQuery] = useState(currentSeriesName);
  const [submitted, setSubmitted] = useState<string | null>(currentSeriesName.trim() ? currentSeriesName.trim() : null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const search = useQuery({
    queryKey: queryKeys.bookSeriesSearch(bookId, submitted ?? ''),
    queryFn: () => api.searchBookSeries(bookId, submitted!),
    enabled: submitted !== null && submitted.length > 0,
  });

  const bind = useMutation({
    mutationFn: (hardcoverSeriesId: number) => api.bindBookSeries(bookId, hardcoverSeriesId),
    onSuccess: (response: RefreshBookSeriesResponse) => {
      queryClient.setQueryData(seriesQueryKey, { series: response.series });
      queryClient.invalidateQueries({ queryKey: queryKeys.book(bookId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.books() });
      queryClient.invalidateQueries({ queryKey: seriesQueryKey });
      toast.success('Series updated');
      onClose();
    },
    onError: (error: unknown) => {
      setErrorMessage(`Failed to bind series: ${getErrorMessage(error)}`);
    },
  });

  const handleSubmit = () => {
    const trimmed = query.trim();
    if (trimmed.length === 0) return;
    setErrorMessage(null);
    setSubmitted(trimmed);
  };

  const candidates = search.data?.candidates ?? [];

  return (
    <Modal onClose={onClose} className="w-full max-w-lg flex flex-col max-h-[85vh]">
      <div role="dialog" aria-modal="true" aria-labelledby="fix-series-modal-title" tabIndex={-1}>
        <div className="px-6 pt-5 pb-4 flex items-center justify-between shrink-0">
          <h2 id="fix-series-modal-title" className="font-display text-lg font-semibold tracking-tight">
            Fix Series
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-muted-foreground hover:text-foreground rounded-lg transition-colors focus-ring"
            aria-label="Close"
          >
            <XIcon className="w-4 h-4" />
          </button>
        </div>
        <div className="border-t border-white/5" />

        <div className="p-6 space-y-4 overflow-y-auto">
          <div className="flex gap-2">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); }}
              placeholder="Search Hardcover series…"
              aria-label="Search Hardcover series"
              data-testid="fix-series-search-input"
              className="flex-1 px-3 py-2 text-sm bg-muted/50 rounded-xl outline-none focus-ring"
            />
            <button
              type="button"
              onClick={handleSubmit}
              disabled={query.trim().length === 0}
              aria-label="Search"
              className="px-4 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-xl hover:opacity-90 transition-all disabled:opacity-40 disabled:cursor-not-allowed focus-ring"
            >
              <SearchIcon className="w-4 h-4" />
            </button>
          </div>

          {errorMessage && (
            <div role="alert" className="text-xs text-red-400 bg-destructive/10 rounded-lg px-3 py-2">
              {errorMessage}
            </div>
          )}

          {search.isFetching ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground">
              <LoadingSpinner className="w-5 h-5" />
            </div>
          ) : search.isError ? (
            <p className="text-xs text-red-400 py-4 text-center">Search failed. Try again.</p>
          ) : submitted !== null && candidates.length === 0 ? (
            <p className="text-xs text-muted-foreground py-4 text-center">No matching Hardcover series found.</p>
          ) : (
            <ul className="space-y-1" data-testid="fix-series-candidates">
              {candidates.map((candidate) => (
                <CandidateRow
                  key={candidate.id}
                  candidate={candidate}
                  disabled={bind.isPending}
                  onSelect={() => bind.mutate(candidate.id)}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}
