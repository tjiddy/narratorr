import { Link } from 'react-router-dom';
import { CheckCircleIcon } from './icons';

interface Props {
  bookId: number;
  textBreakpoint?: 'sm';
}

/**
 * "In Library" ownership badge.
 *
 * Edition-level divergence (#1712): the client identity predicate
 * (`lib/helpers.ts`, `shared/dedup.ts`) is narrator-blind, so with Multiple
 * Narrations this badge necessarily COARSENS to "you own a version" — it cannot
 * tell which *recording* (unabridged vs full-cast, narrator A vs B) you own. This
 * is intentional: the coarse signal is never contradictory — the #1662 single-home
 * guarantee means a title resolves to one library home — so the badge never claims
 * you do NOT own a title you actually do (no false negatives). A narrator-aware
 * client predicate is explicitly out of scope for this story.
 */
export function InLibraryBadge({ bookId, textBreakpoint = 'sm' }: Props) {
  const textClass = textBreakpoint === 'sm' ? 'hidden sm:inline' : 'inline';
  return (
    <Link
      to={`/books/${bookId}`}
      className="flex items-center gap-2 px-4 py-2.5 text-success font-medium hover:underline focus-ring"
      aria-label="View this book in your library"
    >
      <CheckCircleIcon className="w-4 h-4" />
      <span className={textClass}>In Library</span>
    </Link>
  );
}
