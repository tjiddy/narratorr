import { Link } from 'react-router-dom';
import { ArrowLeftIcon, BookOpenIcon } from '@/components/icons';

export function BookNotFound() {
  return (
    <div className="flex flex-col items-center justify-center py-24 animate-fade-in-up">
      <div className="relative mb-8">
        <div className="absolute inset-0 bg-primary/20 rounded-full blur-2xl" />
        <div className="relative p-6 bg-gradient-to-br from-primary/10 to-amber-500/10 rounded-full">
          <BookOpenIcon className="w-16 h-16 text-muted-foreground/50" />
        </div>
      </div>
      <h2 className="font-display text-2xl font-semibold mb-2">Book not found</h2>
      <p className="text-muted-foreground mb-6">The book you&apos;re looking for doesn&apos;t exist or couldn&apos;t be loaded.</p>
      <Link
        to="/library"
        className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium glass-card rounded-xl hover:border-primary/30 hover:text-primary transition-all focus-ring"
      >
        <ArrowLeftIcon className="w-4 h-4" />
        Back to Library
      </Link>
    </div>
  );
}
