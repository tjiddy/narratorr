export function BookSkeleton() {
  return (
    <div className="space-y-6">
      {/* Back button */}
      <div className="h-5 w-24 skeleton rounded" />

      {/* Hero: cover + text */}
      <div className="flex flex-col sm:flex-row gap-6 sm:gap-8">
        <div className="w-48 sm:w-56 lg:w-72 aspect-[2/3] skeleton rounded-2xl shrink-0 mx-auto sm:mx-0" />
        <div className="flex-1 space-y-4">
          <div className="h-10 w-3/4 skeleton rounded" />
          <div className="h-5 w-1/2 skeleton rounded" />
          <div className="h-4 w-1/3 skeleton rounded" />
          <div className="h-4 w-1/4 skeleton rounded" />
          <div className="h-4 w-2/5 skeleton rounded" />
          <div className="flex gap-3 mt-6">
            <div className="h-11 w-40 skeleton rounded-xl" />
            <div className="h-11 w-40 skeleton rounded-xl" />
          </div>
        </div>
      </div>

      {/* Content grid: description (2/3) + sidebar (1/3) */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-3">
          <div className="h-4 w-32 skeleton rounded" />
          <div className="skeleton rounded-2xl h-40" />
        </div>
        <div className="space-y-6">
          <div className="space-y-3">
            <div className="h-4 w-28 skeleton rounded" />
            <div className="skeleton rounded-2xl h-20" />
          </div>
          <div className="space-y-3">
            <div className="h-4 w-20 skeleton rounded" />
            <div className="skeleton rounded-2xl h-16" />
          </div>
        </div>
      </div>
    </div>
  );
}
