import { AlertCircleIcon } from '@/components/icons';

export function LibraryErrorState() {
  return (
    <div className="flex flex-col items-center justify-center py-16 sm:py-24 text-center animate-fade-in-up" data-testid="library-error">
      <div className="relative mb-8">
        <div className="absolute inset-0 bg-destructive/20 rounded-full blur-2xl" />
        <div className="relative p-6 bg-gradient-to-br from-destructive/10 to-red-500/10 rounded-full">
          <AlertCircleIcon className="w-16 h-16 text-destructive" />
        </div>
      </div>
      <h3 className="font-display text-2xl sm:text-3xl font-semibold mb-3">Something went wrong</h3>
      <p className="text-muted-foreground max-w-md">Failed to load your library. Please try again.</p>
    </div>
  );
}
