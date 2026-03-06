import { useBookEventHistory } from '@/hooks/useEventHistory';
import { EventHistoryCard } from '@/components/EventHistoryCard';
import { LoadingSpinner, HistoryIcon } from '@/components/icons';

export function BookEventHistory({ bookId }: { bookId: number }) {
  const { events, isLoading, markFailedMutation } = useBookEventHistory(bookId);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <LoadingSpinner className="w-6 h-6 text-primary" />
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div className="glass-card rounded-2xl p-8 text-center">
        <HistoryIcon className="w-10 h-10 text-muted-foreground/40 mx-auto mb-3" />
        <p className="text-base font-medium">No history yet</p>
        <p className="text-sm text-muted-foreground mt-1">
          Events will appear here as this book is processed
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {events.map((event, idx) => (
        <EventHistoryCard
          key={event.id}
          event={event}
          onMarkFailed={(id) => markFailedMutation.mutate(id)}
          isMarkingFailed={markFailedMutation.isPending}
          showBookTitle={false}
          index={idx}
        />
      ))}
    </div>
  );
}
