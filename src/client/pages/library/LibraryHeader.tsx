import { Link } from 'react-router-dom';
import { ImportIcon } from '@/components/icons';
import { PageHeader } from '@/components/PageHeader.js';

export function LibraryHeader({ subtitle }: { subtitle?: string }) {
  return (
    <div className="flex items-start justify-between">
      <PageHeader title="Library" subtitle={subtitle ?? 'Your audiobook collection'} />
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
