export function DiscoverSkeleton() {
  return (
    <div className="space-y-4" data-testid="discover-skeleton">
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="glass-card rounded-2xl p-4 sm:p-5 animate-fade-in-up"
          style={{ animationDelay: `${Math.min(i, 9) * 50}ms` }}
        >
          <div className="flex gap-4 sm:gap-5">
            <div className="shrink-0 w-20 h-28 sm:w-24 sm:h-32 rounded-xl skeleton" />
            <div className="flex-1 min-w-0 space-y-3 py-1">
              <div className="h-5 w-3/4 skeleton rounded-md" />
              <div className="h-4 w-1/2 skeleton rounded-md" />
              <div className="h-3 w-2/5 skeleton rounded-md" />
              <div className="flex gap-2 pt-2">
                <div className="h-6 w-16 skeleton rounded-lg" />
                <div className="h-6 w-20 skeleton rounded-lg" />
              </div>
            </div>
            <div className="shrink-0 flex flex-col gap-2 justify-center">
              <div className="h-9 w-20 skeleton rounded-xl" />
              <div className="h-9 w-20 skeleton rounded-xl" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
