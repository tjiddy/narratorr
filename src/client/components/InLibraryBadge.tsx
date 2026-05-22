import { Link } from 'react-router-dom';
import { CheckCircleIcon } from './icons';

interface Props {
  bookId: number;
  textBreakpoint?: 'sm';
}

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
