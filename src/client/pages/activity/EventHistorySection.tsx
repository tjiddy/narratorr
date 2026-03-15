import { useState } from 'react';
import { useEventHistory } from '@/hooks/useEventHistory';
import { EventHistoryCard } from '@/components/EventHistoryCard';
import { ConfirmModal } from '@/components/ConfirmModal';
import { LoadingSpinner, HistoryIcon, SearchIcon, TrashIcon } from '@/components/icons';

const EVENT_TYPE_FILTERS = [
  { value: '', label: 'All' },
  { value: 'grabbed', label: 'Grabbed' },
  { value: 'download_completed', label: 'Completed' },
  { value: 'download_failed', label: 'Failed' },
  { value: 'imported', label: 'Imported' },
  { value: 'import_failed', label: 'Import Failed' },
  { value: 'upgraded', label: 'Upgraded' },
  { value: 'deleted', label: 'Deleted' },
  { value: 'renamed', label: 'Renamed' },
];

export function EventHistorySection() {
  const [eventType, setEventType] = useState('');
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [confirmAction, setConfirmAction] = useState<'errors' | 'all' | null>(null);

  const { events, isLoading, markFailedMutation, deleteMutation, bulkDeleteMutation } = useEventHistory({
    eventType: eventType || undefined,
    search: search || undefined,
  });

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSearch(searchInput);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <LoadingSpinner className="w-8 h-8 text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center">
        {/* Type filter pills */}
        <div className="flex flex-wrap gap-1.5">
          {EVENT_TYPE_FILTERS.map((filter) => (
            <button
              key={filter.value}
              onClick={() => setEventType(filter.value)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                eventType === filter.value
                  ? 'bg-primary text-primary-foreground shadow-glow'
                  : 'bg-muted text-muted-foreground hover:text-foreground'
              }`}
            >
              {filter.label}
            </button>
          ))}
        </div>

        {/* Bulk actions */}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setConfirmAction('errors')}
            disabled={bulkDeleteMutation.isPending}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-destructive/10 text-destructive hover:bg-destructive/20 disabled:opacity-50 transition-colors"
          >
            <TrashIcon className="w-3 h-3" />
            Clear Errors
          </button>
          <button
            type="button"
            onClick={() => setConfirmAction('all')}
            disabled={bulkDeleteMutation.isPending}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-muted text-muted-foreground hover:text-foreground disabled:opacity-50 transition-colors"
          >
            <TrashIcon className="w-3 h-3" />
            Clear All
          </button>
        </div>

        {/* Search */}
        <form onSubmit={handleSearchSubmit} className="flex gap-2 sm:ml-auto">
          <div className="relative">
            <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground/50" />
            <input
              type="text"
              placeholder="Search by title..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onBlur={() => setSearch(searchInput)}
              className="pl-9 pr-3 py-1.5 text-sm bg-muted/50 rounded-xl border border-border/50 focus:border-primary/50 focus:ring-1 focus:ring-primary/20 outline-none w-52 transition-colors placeholder:text-muted-foreground/40"
            />
          </div>
        </form>
      </div>

      {/* Event list */}
      {events.length === 0 ? (
        <div className="glass-card rounded-2xl p-8 sm:p-12 text-center">
          <HistoryIcon className="w-12 h-12 text-muted-foreground/40 mx-auto mb-4" />
          <p className="text-lg font-medium">No events</p>
          <p className="text-sm text-muted-foreground mt-1">
            {eventType || search ? 'No events match your filters' : 'Events will appear here as books are processed'}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {events.map((event, idx) => (
            <EventHistoryCard
              key={event.id}
              event={event}
              onMarkFailed={(id) => markFailedMutation.mutate(id)}
              isMarkingFailed={markFailedMutation.isPending}
              onDelete={(id) => deleteMutation.mutate(id)}
              isDeleting={deleteMutation.isPending}
              index={idx}
            />
          ))}
        </div>
      )}
      <ConfirmModal
        isOpen={confirmAction !== null}
        title={confirmAction === 'errors' ? 'Clear Error Events' : 'Clear All Events'}
        message={confirmAction === 'errors'
          ? 'This will permanently delete all failed download and import events. This cannot be undone.'
          : 'This will permanently delete all event history. This cannot be undone.'}
        confirmLabel={confirmAction === 'errors' ? 'Clear Errors' : 'Clear All'}
        onConfirm={() => {
          if (confirmAction === 'errors') {
            bulkDeleteMutation.mutate({ eventType: 'download_failed' }, {
              onSuccess: () => {
                bulkDeleteMutation.mutate({ eventType: 'import_failed' });
              },
            });
          } else {
            bulkDeleteMutation.mutate(undefined);
          }
          setConfirmAction(null);
        }}
        onCancel={() => setConfirmAction(null)}
      />
    </div>
  );
}
