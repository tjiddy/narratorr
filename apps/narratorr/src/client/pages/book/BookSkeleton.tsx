export function BookSkeleton() {
  return (
    <div className="space-y-8">
      <div className="h-5 w-24 skeleton rounded" />
      <div className="flex flex-col sm:flex-row gap-8">
        <div className="w-48 sm:w-56 lg:w-72 aspect-square skeleton rounded-2xl shrink-0 mx-auto sm:mx-0" />
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
    </div>
  );
}
