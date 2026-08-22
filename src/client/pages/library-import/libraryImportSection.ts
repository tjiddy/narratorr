import type { DiscoveredBook } from '@/lib/api';

type DuplicateReason = NonNullable<DiscoveredBook['duplicateReason']>;

/** Where a discovered row renders. Deliberately NOT an eligibility signal — see below. */
export type LibraryImportSection = 'new' | 'duplicate-copy' | 'existing-path';

/**
 * #2091 — the visual split of the duplicate class, kept strictly separate from
 * `isLibraryDbDuplicate`, which remains the single predicate for selection, counts, and match
 * candidacy. Anything that is not `'new'` here is ineligible there; the reverse mapping is what
 * this function adds, and folding the two together would make a rendering change a selection bug.
 *
 * Total by construction: the switch is exhaustive over `DuplicateReason`, so a third reason is a
 * compile error here rather than a row silently filed under whichever arm the default lands in.
 * A duplicate with no reason at all keeps today's behavior — hidden behind the toggle.
 */
export function libraryImportSection(book: DiscoveredBook): LibraryImportSection {
  if (!book.isDuplicate) return 'new';
  const reason: DuplicateReason | undefined = book.duplicateReason;
  if (reason === undefined) return 'existing-path';
  switch (reason) {
    case 'slug': return 'duplicate-copy';
    case 'path': return 'existing-path';
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}
