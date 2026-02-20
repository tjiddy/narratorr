export function AuthorPageSkeleton() {
  return (
    <div className="space-y-8">
      <div className="h-5 w-24 skeleton rounded" />
      <div className="flex flex-col sm:flex-row gap-8 items-center sm:items-start">
        <div className="w-32 h-32 sm:w-40 sm:h-40 skeleton rounded-full shrink-0" />
        <div className="flex-1 space-y-4 text-center sm:text-left w-full">
          <div className="h-10 w-3/4 skeleton rounded mx-auto sm:mx-0" />
          <div className="h-5 w-1/3 skeleton rounded mx-auto sm:mx-0" />
          <div className="flex gap-2 justify-center sm:justify-start">
            <div className="h-7 w-20 skeleton rounded-xl" />
            <div className="h-7 w-24 skeleton rounded-xl" />
          </div>
          <div className="h-20 w-full skeleton rounded-2xl" />
        </div>
      </div>
      {/* Series skeleton */}
      <div className="space-y-4">
        <div className="h-6 w-48 skeleton rounded" />
        <div className="glass-card rounded-2xl p-4 space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="flex gap-4 items-center">
              <div className="w-12 aspect-square skeleton rounded-lg shrink-0" />
              <div className="flex-1 space-y-2">
                <div className="h-4 w-3/4 skeleton rounded" />
                <div className="h-3 w-1/2 skeleton rounded" />
              </div>
              <div className="w-9 h-9 skeleton rounded-xl shrink-0" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
