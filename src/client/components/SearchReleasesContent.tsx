import type { BookWithAuthor, SearchResult } from '@/lib/api';
import type { IndexerState } from '@/hooks/useSearchStream';
import type { SearchResponse } from '@/lib/api/search';
import { resolveBookQualityInputs } from '@core/utils/index.js';
import {
  SearchIcon,
  LoadingSpinner,
  AlertTriangleIcon,
  CheckIcon,
  AlertCircleIcon,
  XIcon,
} from '@/components/icons';
import { UnsupportedSection } from '@/components/UnsupportedSection';
import { ReleaseCard } from '@/components/ReleaseCard';

// ============================================================================
// Indexer Status Row
// ============================================================================

function IndexerStatusIcon({ status }: { status: IndexerState['status'] }) {
  switch (status) {
    case 'pending':
      return <LoadingSpinner className="w-4 h-4 text-primary" />;
    case 'complete':
      return <CheckIcon className="w-4 h-4 text-green-400" />;
    case 'error':
      return <AlertCircleIcon className="w-4 h-4 text-destructive" />;
    case 'cancelled':
      return <XIcon className="w-4 h-4 text-muted-foreground" />;
  }
}

function IndexerStatusRow({
  indexer,
  onCancel,
}: {
  indexer: IndexerState;
  onCancel: (id: number) => void;
}) {
  const statusText = (() => {
    switch (indexer.status) {
      case 'pending': return 'Searching...';
      case 'complete': return `${indexer.resultCount ?? 0} result${(indexer.resultCount ?? 0) !== 1 ? 's' : ''}`;
      case 'error': return indexer.error ?? 'Failed';
      case 'cancelled': return 'Cancelled';
    }
  })();

  return (
    <div className="flex items-center justify-between py-2 px-3 rounded-lg bg-card/50">
      <div className="flex items-center gap-3 min-w-0">
        <IndexerStatusIcon status={indexer.status} />
        <span className="text-sm font-medium truncate">{indexer.name}</span>
        <span className={`text-xs ${indexer.status === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}>
          {statusText}
        </span>
      </div>
      {indexer.status === 'pending' && (
        <button
          type="button"
          onClick={() => onCancel(indexer.id)}
          className="text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded hover:bg-muted/80 transition-colors"
        >
          Cancel
        </button>
      )}
    </div>
  );
}

// ============================================================================
// Phase Components
// ============================================================================

function SearchingPhase({
  indexers,
  hasResults,
  onCancelIndexer,
  onShowResults,
}: {
  indexers: IndexerState[];
  hasResults: boolean;
  onCancelIndexer: (id: number) => void;
  onShowResults: () => void;
}) {
  return (
    <>
      <div className="space-y-2">
        {indexers.map(indexer => (
          <IndexerStatusRow key={indexer.id} indexer={indexer} onCancel={onCancelIndexer} />
        ))}
        {indexers.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12">
            <LoadingSpinner className="w-8 h-8 text-primary mb-4" />
            <p className="text-muted-foreground">Connecting to indexers...</p>
          </div>
        )}
      </div>
      {hasResults && (
        <div className="flex justify-center pt-2">
          <button
            type="button"
            onClick={onShowResults}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors focus-ring"
          >
            Show results
          </button>
        </div>
      )}
    </>
  );
}

function ResultsPhase({
  searchResponse,
  resultKeys,
  book,
  isGrabbing,
  isBlacklisting,
  onGrab,
  onBlacklist,
}: {
  searchResponse: SearchResponse | null;
  resultKeys: string[];
  book: BookWithAuthor;
  isGrabbing: boolean;
  isBlacklisting: boolean;
  onGrab: (result: SearchResult) => void;
  onBlacklist: (result: SearchResult) => void;
}) {
  const results = searchResponse?.results;
  const unsupportedResults = searchResponse?.unsupportedResults;

  return (
    <>
      {!searchResponse && (
        <div className="flex flex-col items-center justify-center py-12">
          <LoadingSpinner className="w-8 h-8 text-primary mb-4" />
          <p className="text-muted-foreground">Finalizing results...</p>
        </div>
      )}

      {results?.length === 0 && searchResponse && (
        <div className="flex flex-col items-center justify-center py-12">
          <SearchIcon className="w-10 h-10 text-muted-foreground/40 mb-4" />
          <p className="text-muted-foreground">No releases found</p>
        </div>
      )}

      {searchResponse?.durationUnknown && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-yellow-500/10 border border-yellow-500/20 text-sm text-yellow-300">
          <AlertTriangleIcon className="w-4 h-4 shrink-0" />
          Duration unknown — quality filtering is disabled for this book
        </div>
      )}

      {results && results.length > 0 && (
        <>
          <p className="text-sm text-muted-foreground">
            Found {results.length} release{results.length !== 1 ? 's' : ''}
          </p>
          <div className="grid gap-3">
            {results.map((result, index) => {
              const { sizeBytes: bookSize, durationSeconds: bookDur } = resolveBookQualityInputs(book);
              return (
                <ReleaseCard
                  key={resultKeys[index]}
                  result={result}
                  bookDurationSeconds={bookDur ?? undefined}
                  existingBookSizeBytes={book.status === 'imported' ? (bookSize ?? undefined) : undefined}
                  lastGrabGuid={book.lastGrabGuid}
                  lastGrabInfoHash={book.lastGrabInfoHash}
                  onGrab={() => onGrab(result)}
                  onBlacklist={() => onBlacklist(result)}
                  isGrabbing={isGrabbing}
                  isBlacklisting={isBlacklisting}
                />
              );
            })}
          </div>
        </>
      )}

      {unsupportedResults && unsupportedResults.count > 0 && (
        <UnsupportedSection titles={unsupportedResults.titles} count={unsupportedResults.count} />
      )}
    </>
  );
}

// ============================================================================
// Main Component
// ============================================================================

interface SearchReleasesContentProps {
  phase: 'idle' | 'searching' | 'results';
  indexers: IndexerState[];
  hasResults: boolean;
  error: string | null;
  searchResponse: SearchResponse | null;
  resultKeys: string[];
  book: BookWithAuthor;
  isGrabbing: boolean;
  isBlacklisting: boolean;
  onCancelIndexer: (id: number) => void;
  onShowResults: () => void;
  onRetry: () => void;
  onGrab: (result: SearchResult) => void;
  onBlacklist: (result: SearchResult) => void;
}

export function SearchReleasesContent({
  phase,
  indexers,
  hasResults,
  error,
  searchResponse,
  resultKeys,
  book,
  isGrabbing,
  isBlacklisting,
  onCancelIndexer,
  onShowResults,
  onRetry,
  onGrab,
  onBlacklist,
}: SearchReleasesContentProps) {
  return (
    <div className="flex-1 overflow-y-auto overflow-x-hidden p-6 space-y-4">
      {phase === 'searching' && (
        <SearchingPhase
          indexers={indexers}
          hasResults={hasResults}
          onCancelIndexer={onCancelIndexer}
          onShowResults={onShowResults}
        />
      )}

      {error && phase === 'idle' && (
        <div className="flex flex-col items-center justify-center py-12 space-y-3">
          <div className="flex items-center gap-3 px-4 py-3 bg-destructive/10 text-destructive rounded-xl">
            <p>Search failed: {error}</p>
          </div>
          <button type="button" onClick={onRetry} className="text-sm text-primary hover:text-primary/80">
            Retry
          </button>
        </div>
      )}

      {phase === 'results' && (
        <ResultsPhase
          searchResponse={searchResponse}
          resultKeys={resultKeys}
          book={book}
          isGrabbing={isGrabbing}
          isBlacklisting={isBlacklisting}
          onGrab={onGrab}
          onBlacklist={onBlacklist}
        />
      )}
    </div>
  );
}
