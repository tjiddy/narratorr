export function LibraryHeader({ subtitle }: { subtitle?: string }) {
  return (
    <div className="animate-fade-in-up">
      <h1 className="font-display text-3xl sm:text-4xl font-bold tracking-tight">Library</h1>
      <p className="text-muted-foreground mt-1">{subtitle ?? 'Your audiobook collection'}</p>
    </div>
  );
}
