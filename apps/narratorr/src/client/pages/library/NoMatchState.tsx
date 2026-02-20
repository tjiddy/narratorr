import { SearchIcon } from '@/components/icons';

export function NoMatchState({ onClearFilters }: { onClearFilters: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 sm:py-24 animate-fade-in-up">
      <div className="text-muted-foreground/40 mb-6">
        <SearchIcon className="w-12 h-12" />
      </div>
      <h3 className="font-display text-xl sm:text-2xl font-semibold text-center mb-2">
        No books match your filters
      </h3>
      <p className="text-muted-foreground text-center max-w-md mb-6">
        Try adjusting your filters to see more results
      </p>
      <button
        onClick={onClearFilters}
        className="px-5 py-2.5 text-sm font-medium glass-card rounded-xl hover:border-primary/30 hover:text-primary transition-all focus-ring"
      >
        Clear Filters
      </button>
    </div>
  );
}
