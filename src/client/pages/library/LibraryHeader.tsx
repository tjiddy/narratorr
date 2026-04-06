import { Link } from 'react-router-dom';
import { ImportIcon } from '@/components/icons';

export function LibraryHeader({ subtitle }: { subtitle?: string }) {
  return (
    <div className="animate-fade-in-up flex items-start justify-between">
      <div>
        <h1 className="font-display text-3xl sm:text-4xl font-bold tracking-tight">Library</h1>
        <p className="text-muted-foreground mt-1">{subtitle ?? 'Your audiobook collection'}</p>
      </div>
      <Link
        to="/import"
        className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-muted-foreground/45 rounded-xl hover:text-muted-foreground/80 hover:bg-white/5 hover:border hover:border-white/10 transition-all"
      >
        <ImportIcon className="w-4 h-4" />
        Import Files
      </Link>
    </div>
  );
}
