import { HourglassIcon } from '@/components/icons';

/**
 * The "the run was torn down before it finished" empty state. Distinct from a genuine indexer miss
 * and from the quality-filter one, and it outranks both: a torn run never reached the gates, so it
 * has no filter verdict to report and its empty list is not an answer.
 */
export function TimedOutEmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
      <HourglassIcon className="w-10 h-10 text-muted-foreground/40 mb-4" />
      <p className="text-foreground font-medium">This search ran out of time</p>
      <p className="text-sm text-muted-foreground mt-2">
        It was stopped at its deadline before every indexer answered, so this is not a result —
        run the search again, or narrow the query.
      </p>
    </div>
  );
}
